package com.autonaitra.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * A game page: a WebView kept off screen (never attached to a window, so Chromium treats it as
 * visible and never slows it down). It is what a Playwright page is on the server: the engine
 * loads URLs in it and runs scripts in it (engine/src/shims/playwright.js).
 *
 * The viewport is 1280x900 CSS pixels with a desktop user agent, as the server's Chromium has,
 * so the game serves the same pages the bot was written for. Images are not loaded, as on the
 * server.
 */
// Profile calls are only made when the engine has checked WebViewFeature.MULTI_PROFILE.
@SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
class GamePage(
    val id: String,
    context: Context,
    profile: String?,
    hook: String,
    private val engine: BotEngine,
) {
    companion object {
        private const val TAG = "auto-naitra"
        const val WIDTH = 1280
        const val HEIGHT = 900
        private val encoder = Executors.newSingleThreadExecutor()

        /** The WebView's own user agent turned into desktop Chrome's (same Chrome version). */
        fun desktopUserAgent(mobile: String): String {
            val major = Regex("Chrome/(\\d+)").find(mobile)?.groupValues?.get(1) ?: "130"
            return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$major.0.0.0 Safari/537.36"
        }
    }

    private class Pending(val callId: Int, val timeout: Runnable)

    private val main = Handler(Looper.getMainLooper())
    private val density = context.resources.displayMetrics.density
    val view = WebView(context)

    /** Address of the page, as last reported (read from the engine's thread). */
    @Volatile
    var url: String = "about:blank"
        private set

    // Main-frame requests started, and how many of them had finished when a page last finished.
    private val started = AtomicInteger(0)

    @Volatile
    private var finished = 0
    private var pendingGoto: Pending? = null

    // Scripts still running; a destroyed WebView never answers, so destroy() fails them.
    private val pendingEvals = mutableSetOf<Int>()

    @Volatile
    var closed = false
        private set

    init {
        if (!profile.isNullOrEmpty() && engine.multiProfile) {
            ProfileStore.getInstance().getOrCreateProfile(profile)
            WebViewCompat.setProfile(view, profile)
        }
        with(view.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadsImagesAutomatically = false
            blockNetworkImage = true
            mediaPlaybackRequiresUserGesture = true
            useWideViewPort = false
            loadWithOverviewMode = false
            textZoom = 100
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = desktopUserAgent(userAgentString)
        }
        view.setBackgroundColor(Color.WHITE)
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(view, hook, setOf("*"))
        }
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        // Laid out off screen at 1280x900 CSS pixels.
        val w = (WIDTH * density).toInt()
        val h = (HEIGHT * density).toInt()
        view.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, w, h)
    }

    fun navState(): String = "${started.get()},$finished"

    /** Loads `target`; reports back once the page has finished loading (or failed, or timed out). */
    fun goto(callId: Int, target: String, timeoutMs: Int) {
        pendingGoto?.let {
            main.removeCallbacks(it.timeout)
            engine.done(it.callId, false, "page.goto: interrupted by another navigation to $target")
        }
        val timeout = Runnable {
            if (pendingGoto?.callId == callId) {
                pendingGoto = null
                engine.done(callId, false, "page.goto: Timeout ${timeoutMs}ms exceeded.\nnavigating to \"$target\"")
            }
        }
        pendingGoto = Pending(callId, timeout)
        main.postDelayed(timeout, timeoutMs.toLong())
        view.loadUrl(target)
    }

    private fun finishGoto(ok: Boolean, message: String) {
        val p = pendingGoto ?: return
        pendingGoto = null
        main.removeCallbacks(p.timeout)
        engine.done(p.callId, ok, message)
    }

    /** Runs `script` in the page; the engine gets evaluateJavascript's result ("null" if none). */
    fun eval(callId: Int, script: String) {
        if (closed) {
            engine.done(callId, false, "Target page, context or browser has been closed")
            return
        }
        pendingEvals.add(callId)
        view.evaluateJavascript(script) { result ->
            if (pendingEvals.remove(callId)) engine.done(callId, true, result ?: "null")
        }
    }

    /** Saves what the page shows (its 1280x900 viewport) as a PNG. */
    fun screenshot(callId: Int, file: File) {
        val w = view.width
        val h = view.height
        if (w <= 0 || h <= 0) {
            engine.done(callId, false, "page.screenshot: the page has no size")
            return
        }
        val bitmap = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.WHITE)
        canvas.scale(WIDTH.toFloat() / w, HEIGHT.toFloat() / h)
        view.draw(canvas)
        encoder.execute {
            try {
                file.parentFile?.mkdirs()
                FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                engine.done(callId, true, "")
            } catch (e: Exception) {
                engine.done(callId, false, "page.screenshot: ${e.message}")
            } finally {
                bitmap.recycle()
            }
        }
    }

    fun destroy() {
        if (closed) return
        closed = true
        finishGoto(false, "Target page, context or browser has been closed")
        pendingEvals.forEach { engine.done(it, false, "Target page, context or browser has been closed") }
        pendingEvals.clear()
        view.stopLoading()
        view.webChromeClient = null
        view.destroy()
    }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (request.isForMainFrame) started.incrementAndGet()
            return null
        }

        // Game pages may only go to web addresses (no app links or intents).
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val scheme = request.url.scheme ?: return true
            return scheme != "http" && scheme != "https"
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            this@GamePage.url = url
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            this@GamePage.url = url
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (url != "about:blank") this@GamePage.url = url
            finished = started.get()
            if (url != "about:blank") finishGoto(true, "")
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            Log.w(TAG, "page $id: ${error.description} at ${request.url}")
            finishGoto(false, "page.goto: net::${error.description} at ${request.url}")
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.e(TAG, "page $id: renderer gone (crashed: ${detail.didCrash()})")
            engine.onRendererGone()
            return true
        }
    }

    // Dialogs are dismissed, as Playwright does by default (leaving a page is always allowed).
    private inner class Chrome : WebChromeClient() {
        override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
            result.confirm()
            return true
        }

        override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
            result.cancel()
            return true
        }

        override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String?, result: JsPromptResult): Boolean {
            result.cancel()
            return true
        }

        override fun onJsBeforeUnload(view: WebView, url: String, message: String, result: JsResult): Boolean {
            result.confirm()
            return true
        }
    }
}
