package com.vibetv.app

import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Tells the web app what it is running on. The same APK serves phones and TVs; the app shows its
 * touch layout or its remote-control layout depending on the answer.
 */
@CapacitorPlugin(name = "VibeDevice")
class VibeDevicePlugin : Plugin() {

    // The Back button (and Back on a remote) is handed to the page as a "back" event; the page closes
    // what is open, and asks to leave the app when nothing is.
    override fun load() {
        takeFile(activity.intent)
        activity.runOnUiThread {
            activity.onBackPressedDispatcher.addCallback(
                activity,
                object : androidx.activity.OnBackPressedCallback(true) {
                    override fun handleOnBackPressed() {
                        notifyListeners("back", JSObject())
                    }
                }
            )
        }
    }

    // "Open with Vibe TV" on a playlist file. The file is read here (only this side may open the
    // address another app hands over) and passed to the page as an "opened" event, which waits
    // until the page listens.
    private fun takeFile(intent: android.content.Intent?) {
        if (intent?.action != android.content.Intent.ACTION_VIEW) return
        val uri = intent.data ?: return
        intent.data = null // not again when the screen is rebuilt
        Thread {
            try {
                var name = uri.lastPathSegment?.substringAfterLast('/') ?: "Playlist"
                if (uri.scheme == "content") {
                    context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                        if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0)
                    }
                }
                val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
                    val out = java.io.ByteArrayOutputStream()
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        if (out.size() > 64 * 1024 * 1024) throw java.io.IOException("The file is too large")
                    }
                    out.toByteArray()
                } ?: return@Thread
                val file = JSObject().put("name", name).put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                notifyListeners("opened", file, true)
            } catch (e: Exception) {
                android.util.Log.w("VibeTV", "Could not read the opened file: " + e.message)
            }
        }.start()
    }

    override fun handleOnNewIntent(intent: android.content.Intent) {
        takeFile(intent)
    }

    /** Leaves the app the way Back does on its first screen: it goes to the background, still open. */
    @PluginMethod
    fun leave(call: PluginCall) {
        activity.moveTaskToBack(true)
        call.resolve()
    }

    @PluginMethod
    fun getInfo(call: PluginCall) {
        val uiMode = context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        val pm = context.packageManager
        // Fire TV reports itself through the leanback feature or its own "amazon.hardware.fire_tv".
        val tv = uiMode?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
            pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
            pm.hasSystemFeature("amazon.hardware.fire_tv")

        val info = pm.getPackageInfo(context.packageName, 0)
        call.resolve(
            JSObject()
                .put("tv", tv)
                .put("version", info.versionName ?: "")
                .put("touch", pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN))
        )
    }
}
