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
        // Only addresses another app hands over: file:// or this app's own provider would let an
        // outside intent make the app read (and pass to the page) its own private files.
        if (uri.scheme != "content" || uri.authority?.startsWith(context.packageName) != false) return
        intent.data = null // not again when the screen is rebuilt
        Thread {
            try {
                var name = uri.lastPathSegment?.substringAfterLast('/') ?: "Playlist"
                context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0)
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

    /** A key of the remote that the page is not told about itself (MainActivity.dispatchKeyEvent). */
    fun remoteKey(name: String) {
        notifyListeners("key", JSObject().put("key", name))
    }

    /**
     * Asks for a line of text in a dialog of the system's own. On a TV this is how text is typed:
     * a text field inside the page would take every key of the remote for itself.
     * prompt({ title, value, password, hint }) -> { value } or { cancelled: true }
     */
    @PluginMethod
    fun prompt(call: PluginCall) {
        val password = call.getBoolean("password") ?: false
        activity.runOnUiThread {
            val field = android.widget.EditText(activity)
            field.setSingleLine(true)
            field.inputType = android.text.InputType.TYPE_CLASS_TEXT or
                (if (password) android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD else android.text.InputType.TYPE_TEXT_VARIATION_URI or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
            field.imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE
            field.hint = call.getString("hint") ?: ""
            field.setText(call.getString("value") ?: "")
            field.setSelection(field.text.length)
            val pad = (20 * context.resources.displayMetrics.density).toInt()
            val box = android.widget.FrameLayout(activity)
            box.setPadding(pad, pad / 2, pad, 0)
            box.addView(field)
            var answered = false
            val dialog = androidx.appcompat.app.AlertDialog.Builder(activity)
                .setTitle(call.getString("title") ?: "")
                .setView(box)
                .setPositiveButton(android.R.string.ok) { _, _ -> answered = true; call.resolve(JSObject().put("value", field.text.toString())) }
                .setNegativeButton(android.R.string.cancel, null)
                .setOnDismissListener { if (!answered) call.resolve(JSObject().put("cancelled", true)) }
                .create()
            field.setOnEditorActionListener { _, action, _ ->
                if (action == android.view.inputmethod.EditorInfo.IME_ACTION_DONE) {
                    answered = true
                    call.resolve(JSObject().put("value", field.text.toString()))
                    dialog.dismiss()
                    true
                } else false
            }
            dialog.window?.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
            dialog.show()
            field.requestFocus()
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
