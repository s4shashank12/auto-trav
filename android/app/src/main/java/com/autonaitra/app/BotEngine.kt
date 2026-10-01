package com.autonaitra.app

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Hosts the bot engine (engine/src/main.js, built into assets/engine): an off-screen WebView in
 * the foreground service that runs the same bot code as the server. This class is the engine's
 * `Native` bridge: SQLite, the Keystore, timers, cookies, files, and the game pages it drives.
 *
 * Methods marked @JavascriptInterface are called from the engine on WebView's bridge thread;
 * anything that touches a WebView is moved to the main thread. Long work answers later with
 * done(callId, ok, payload), which resolves the engine's promise (__nativeDone).
 */
// Profile calls are only made when `multiProfile` (WebViewFeature.MULTI_PROFILE) is true.
@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface", "RequiresFeature")
class BotEngine(private val context: Context, private val listener: Listener) {

    interface Listener {
        fun onEngineReady()
        fun onEngineStatus(json: String)
        fun onApiResponse(requestId: Int, status: Int, body: String)
    }

    companion object {
        private const val TAG = "auto-naitra"
        const val ASSET_HOST = "https://appassets.androidplatform.net/"
    }

    private val main = Handler(Looper.getMainLooper())
    private val db = BotDatabase.get(context)
    private val pages = ConcurrentHashMap<String, GamePage>()
    private val timers = ConcurrentHashMap<Int, Runnable>()
    private val queued = mutableListOf<String>()
    private var view: WebView? = null
    private var restarting = false

    @Volatile
    var ready = false
        private set

    val multiProfile: Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)

    /** Where the engine's files (screenshots) live. */
    private val root: File = File(context.filesDir, "engine").apply { mkdirs() }

    fun start() {
        val web = WebView(context)
        view = web
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        web.addJavascriptInterface(Bridge(), "Native")
        val loader = WebViewAssetLoader.Builder().addPathHandler("/", AssetDir(context, "engine")).build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.e(TAG, "engine: renderer gone (crashed: ${detail.didCrash()})")
                onRendererGone()
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                val text = "engine: ${message.message()}"
                when (message.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> Log.e(TAG, text)
                    ConsoleMessage.MessageLevel.WARNING -> Log.w(TAG, text)
                    else -> Log.i(TAG, text)
                }
                return true
            }
        }
        web.loadUrl("${ASSET_HOST}index.html")
    }

    fun destroy() {
        ready = false
        timers.values.forEach { main.removeCallbacks(it) }
        timers.clear()
        pages.values.forEach { it.destroy() }
        pages.clear()
        view?.let {
            it.removeJavascriptInterface("Native")
            it.destroy()
        }
        view = null
    }

    /** Asks the engine to stop every account (the notification's "Stop all"). */
    fun stopAll() = js("globalThis.__engine && globalThis.__engine.stopAll()")

    /** A request from the dashboard; queued until the engine has started. */
    fun request(requestId: Int, method: String, path: String, body: String) {
        val code = "globalThis.__api($requestId, ${JSONObject.quote(method)}, ${JSONObject.quote(path)}, ${JSONObject.quote(body)})"
        synchronized(queued) {
            if (!ready) {
                queued.add(code)
                return
            }
        }
        js(code)
    }

    /**
     * Every WebView of the app shares one renderer process; when it dies the engine starts over
     * (accounts that were running start again by themselves).
     */
    fun onRendererGone() {
        main.post {
            if (restarting) return@post
            restarting = true
            destroy()
            main.postDelayed({
                restarting = false
                start()
            }, 3000)
        }
    }

    internal fun done(callId: Int, ok: Boolean, payload: String) =
        js("globalThis.__nativeDone($callId, $ok, ${JSONObject.quote(payload)})")

    private fun js(code: String) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            view?.evaluateJavascript(code, null)
        } else {
            main.post { view?.evaluateJavascript(code, null) }
        }
    }

    private fun onMain(callId: Int, block: () -> Unit) = main.post {
        try {
            block()
        } catch (e: Exception) {
            Log.e(TAG, "native call failed", e)
            done(callId, false, e.message ?: e.toString())
        }
    }

    private fun page(pageId: String): GamePage =
        pages[pageId] ?: throw IllegalStateException("Target page, context or browser has been closed")

    private fun cookies(profile: String): CookieManager =
        if (multiProfile && profile.isNotEmpty()) {
            ProfileStore.getInstance().getOrCreateProfile(profile).cookieManager
        } else {
            CookieManager.getInstance()
        }

    /** A path under the engine's folder (never outside it). */
    private fun file(rel: String): File {
        val f = File(root, rel).canonicalFile
        require(f.path.startsWith(root.canonicalPath + File.separator) || f == root.canonicalFile) { "Bad path $rel" }
        return f
    }

    private fun safely(block: () -> String): String = try {
        block()
    } catch (e: Exception) {
        Log.w(TAG, "engine call failed: ${e.message}")
        JSONObject().put("error", e.message ?: e.toString()).toString()
    }

    private inner class Bridge {
        @JavascriptInterface
        fun deviceInfo(): String {
            val webView = WebViewCompat.getCurrentWebViewPackage(context)
            return JSONObject()
                .put("multiProfile", multiProfile)
                .put("documentStartScript", WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT))
                .put("webView", webView?.let { "${it.packageName} ${it.versionName}" } ?: "unknown")
                .put("android", Build.VERSION.RELEASE)
                .put("sdk", Build.VERSION.SDK_INT)
                .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
                .put("app", BuildConfig.VERSION_NAME)
                .toString()
        }

        @JavascriptInterface
        fun engineReady() {
            val flush: List<String>
            synchronized(queued) {
                ready = true
                flush = queued.toList()
                queued.clear()
            }
            flush.forEach { js(it) }
            main.post { listener.onEngineReady() }
        }

        @JavascriptInterface
        fun engineFailed(message: String) {
            Log.e(TAG, "engine failed to start: $message")
        }

        @JavascriptInterface
        fun setStatus(json: String) {
            main.post { listener.onEngineStatus(json) }
        }

        @JavascriptInterface
        fun apiResponse(requestId: Int, status: Int, body: String) {
            main.post { listener.onApiResponse(requestId, status, body) }
        }

        // SQLite

        @JavascriptInterface
        fun dbQuery(sql: String, params: String): String = safely { db.query(sql, JSONArray(params)) }

        @JavascriptInterface
        fun dbRun(sql: String, params: String): String = safely { db.run(sql, JSONArray(params)) }

        @JavascriptInterface
        fun dbBatch(statements: String): String = safely { db.batch(JSONArray(statements)) }

        // Passwords

        @JavascriptInterface
        fun encrypt(plain: String): String = Secrets.encrypt(plain)

        @JavascriptInterface
        fun decrypt(stored: String): String? = Secrets.decrypt(stored)

        // Timers (the engine's setTimeout)

        @JavascriptInterface
        fun timerStart(id: Int, ms: Int) {
            val run = Runnable {
                timers.remove(id)
                view?.evaluateJavascript("globalThis.__timerFire($id)", null)
            }
            timers[id] = run
            main.postDelayed(run, ms.coerceAtLeast(0).toLong())
        }

        @JavascriptInterface
        fun timerCancel(id: Int) {
            timers.remove(id)?.let { main.removeCallbacks(it) }
        }

        // Game pages

        @JavascriptInterface
        fun pageCreate(callId: Int, pageId: String, profile: String, hook: String) = onMain(callId) {
            pages[pageId] = GamePage(pageId, context, profile, hook, this@BotEngine)
            done(callId, true, "")
        }

        @JavascriptInterface
        fun pageClose(callId: Int, pageId: String) = onMain(callId) {
            pages.remove(pageId)?.destroy()
            done(callId, true, "")
        }

        @JavascriptInterface
        fun pageGoto(callId: Int, pageId: String, url: String, timeoutMs: Int) = onMain(callId) {
            page(pageId).goto(callId, url, timeoutMs)
        }

        @JavascriptInterface
        fun pageEval(callId: Int, pageId: String, script: String) = onMain(callId) {
            page(pageId).eval(callId, script)
        }

        @JavascriptInterface
        fun pageUrl(pageId: String): String = pages[pageId]?.url ?: ""

        @JavascriptInterface
        fun pageNavState(pageId: String): String = pages[pageId]?.navState() ?: "0,0"

        @JavascriptInterface
        fun pageScreenshot(callId: Int, pageId: String, path: String) = onMain(callId) {
            page(pageId).screenshot(callId, file(path))
        }

        // Cookies, per account profile (or the shared jar without profile support)

        @JavascriptInterface
        fun cookiesGet(callId: Int, profile: String, origin: String) = onMain(callId) {
            done(callId, true, cookies(profile).getCookie(origin) ?: "")
        }

        @JavascriptInterface
        fun cookiesSet(callId: Int, profile: String, origin: String, list: String) = onMain(callId) {
            val jar = cookies(profile)
            list.split(";").map { it.trim() }.filter { it.contains("=") }.forEach { jar.setCookie(origin, "$it; Path=/") }
            jar.flush()
            done(callId, true, "")
        }

        @JavascriptInterface
        fun cookiesClear(callId: Int, profile: String) = onMain(callId) {
            val jar = cookies(profile)
            jar.removeAllCookies {
                jar.flush()
                done(callId, true, "")
            }
        }

        @JavascriptInterface
        fun profileDelete(callId: Int, profile: String) = onMain(callId) {
            if (multiProfile && profile.isNotEmpty() && pages.isEmpty()) {
                try {
                    ProfileStore.getInstance().deleteProfile(profile)
                } catch (e: Exception) {
                    Log.w(TAG, "profile $profile not deleted: ${e.message}")
                }
            }
            done(callId, true, "")
        }

        // Files (screenshots)

        @JavascriptInterface
        fun listFiles(dir: String): String = safely {
            JSONArray(file(dir).list()?.sorted() ?: emptyList<String>()).toString()
        }

        @JavascriptInterface
        fun readFileBase64(path: String): String = try {
            val f = file(path)
            if (f.isFile) Base64.encodeToString(f.readBytes(), Base64.NO_WRAP) else ""
        } catch (e: Exception) {
            ""
        }

        @JavascriptInterface
        fun deleteFiles(dir: String) {
            try {
                file(dir).deleteRecursively()
            } catch (e: Exception) {
                Log.w(TAG, "delete $dir: ${e.message}")
            }
        }
    }
}
