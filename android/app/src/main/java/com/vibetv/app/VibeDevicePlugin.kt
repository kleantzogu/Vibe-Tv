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
