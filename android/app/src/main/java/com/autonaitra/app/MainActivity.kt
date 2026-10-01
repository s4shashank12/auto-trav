package com.autonaitra.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * The app's screen: the same dashboard as the web version (dashboard/, built into assets/ui),
 * talking to the engine on this phone through the `AutoNaitraAndroid` bridge instead of HTTP.
 */
@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
class MainActivity : Activity() {

    companion object {
        private const val TAG = "auto-naitra"
        private const val NOTIFICATION_REQUEST = 1
    }

    private lateinit var container: FrameLayout
    private var web: WebView? = null
    private var service: BotService? = null
    private var bound = false
    private val pending = mutableListOf<() -> Unit>()

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            val s = (binder as BotService.LocalBinder).service
            service = s
            s.apiListener = { id, status, body -> respond(id, status, body) }
            pending.forEach { it() }
            pending.clear()
        }

        override fun onServiceDisconnected(name: ComponentName) {
            service = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        container = FrameLayout(this)
        container.setBackgroundColor(ContextCompat.getColor(this, R.color.window_bg))
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(container)
        updateBarColors()
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        createWebView()
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_REQUEST)
        }
    }

    override fun onStart() {
        super.onStart()
        try {
            BotService.start(this)
        } catch (e: Exception) {
            Log.w(TAG, "could not start the service: ${e.message}")
        }
        bound = bindService(Intent(this, BotService::class.java), connection, Context.BIND_AUTO_CREATE)
    }

    override fun onStop() {
        service?.apiListener = null
        service = null
        if (bound) unbindService(connection)
        bound = false
        super.onStop()
    }

    override fun onDestroy() {
        web?.destroy()
        web = null
        super.onDestroy()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        updateBarColors()
    }

    @Deprecated("Back goes back through the dashboard's pages first.")
    override fun onBackPressed() {
        val w = web
        if (w != null && w.canGoBack()) w.goBack() else moveTaskToBack(true)
    }

    private fun updateBarColors() {
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }
    }

    private fun createWebView() {
        val w = WebView(this)
        web = w
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.settings.setSupportMultipleWindows(false)
        w.setBackgroundColor(ContextCompat.getColor(this, R.color.window_bg))
        w.addJavascriptInterface(UiBridge(), "AutoNaitraAndroid")
        val loader = WebViewAssetLoader.Builder().addPathHandler("/", AssetDir(this, "ui")).build()
        w.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            // Links out of the app (the game world, docs) open in the browser.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.toString().startsWith(BotEngine.ASSET_HOST)) return false
                openExternal(url)
                return true
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.e(TAG, "dashboard: renderer gone")
                container.removeView(view)
                view.destroy()
                web = null
                container.post { createWebView() }
                return true
            }
        }
        container.addView(w, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        w.loadUrl("${BotEngine.ASSET_HOST}index.html")
    }

    private fun respond(requestId: Int, status: Int, body: String) {
        web?.evaluateJavascript("window.__androidResponse && window.__androidResponse($requestId, $status, ${JSONObject.quote(body)})", null)
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.w(TAG, "no app opens $uri")
        }
    }

    private fun ignoringBatteryOptimizations(): Boolean =
        (getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)

    /** What the dashboard calls (window.AutoNaitraAndroid). Runs on WebView's bridge thread. */
    inner class UiBridge {
        @android.webkit.JavascriptInterface
        fun request(requestId: Int, method: String, path: String, body: String) {
            runOnUiThread {
                val send = { service?.engine?.request(requestId, method, path, body) ?: Unit }
                if (service != null) send() else pending.add(send)
            }
        }

        /** Whether the phone lets the bot run in the background, for the dashboard's Phone card. */
        @android.webkit.JavascriptInterface
        fun phoneStatus(): String {
            val webView = WebViewCompat.getCurrentWebViewPackage(this@MainActivity)
            return JSONObject()
                .put("batteryUnrestricted", ignoringBatteryOptimizations())
                .put("notifications", NotificationManagerCompat.from(this@MainActivity).areNotificationsEnabled())
                .put("multiProfile", WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))
                .put("webView", webView?.let { "${it.packageName} ${it.versionName}" } ?: "unknown")
                .put("android", Build.VERSION.RELEASE)
                .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
                .put("app", BuildConfig.VERSION_NAME)
                .toString()
        }

        /** Asks Android to leave the app out of battery optimisation (Doze would pause the bot). */
        @SuppressLint("BatteryLife")
        @android.webkit.JavascriptInterface
        fun allowBackground() = runOnUiThread {
            if (ignoringBatteryOptimizations()) return@runOnUiThread
            try {
                startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            } catch (e: Exception) {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
        }

        @android.webkit.JavascriptInterface
        fun allowNotifications() = runOnUiThread {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
                shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
            ) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_REQUEST)
            } else {
                startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
            }
        }

        @android.webkit.JavascriptInterface
        fun openUrl(url: String) = runOnUiThread { openExternal(Uri.parse(url)) }
    }
}
