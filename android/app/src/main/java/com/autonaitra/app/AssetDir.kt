package com.autonaitra.app

import android.content.Context
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.IOException

/**
 * Serves one folder of the app's assets at the root of https://appassets.androidplatform.net/,
 * so the dashboard's absolute paths (/assets/..., /favicon.svg) work as on its web host.
 */
class AssetDir(private val context: Context, private val dir: String) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
        val rel = path.substringBefore('?').ifEmpty { "index.html" }
        if (rel.split('/').any { it == ".." }) return null
        return try {
            WebResourceResponse(mimeType(rel), "utf-8", context.assets.open("$dir/$rel"))
        } catch (e: IOException) {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "".byteInputStream())
        }
    }

    private fun mimeType(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "ico" -> "image/x-icon"
        "json" -> "application/json"
        "woff2" -> "font/woff2"
        "woff" -> "font/woff"
        else -> "application/octet-stream"
    }
}
