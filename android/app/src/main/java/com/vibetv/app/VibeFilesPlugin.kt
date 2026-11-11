package com.vibetv.app

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * The app's JSON files (settings.json, playlists/<id>.json, cache/channel-db.json), kept in the app's
 * private folder. The web app's storage backend (platform/android/storage-native.js) calls this.
 *
 * Capacitor runs plugin calls one at a time on its own thread, so writes never overlap, and each
 * write replaces the file in one step (a temporary file renamed into place), as on a computer.
 */
@CapacitorPlugin(name = "VibeFiles")
class VibeFilesPlugin : Plugin() {

    // Only files inside the app's own folder: no "..", no absolute paths.
    private fun resolve(call: PluginCall): File? {
        val path = call.getString("path") ?: ""
        val root = context.filesDir.canonicalFile
        val file = File(root, path).canonicalFile
        if (path.isEmpty() || !file.path.startsWith(root.path + File.separator)) {
            call.reject("Not a file of this app: $path")
            return null
        }
        return file
    }

    @PluginMethod
    fun read(call: PluginCall) {
        val file = resolve(call) ?: return
        // Not an error on this side (Capacitor logs every rejected call): the first start has no files yet.
        if (!file.isFile) return call.resolve(JSObject().put("missing", true))
        try {
            call.resolve(JSObject().put("data", file.readText(Charsets.UTF_8)))
        } catch (e: Exception) {
            call.reject(e.message ?: e.toString())
        }
    }

    @PluginMethod
    fun write(call: PluginCall) {
        val file = resolve(call) ?: return
        val data = call.getString("data") ?: return call.reject("Nothing to write")
        try {
            file.parentFile?.mkdirs()
            val tmp = File(file.path + ".tmp")
            tmp.writeText(data, Charsets.UTF_8)
            if (!tmp.renameTo(file)) throw java.io.IOException("Could not replace ${file.name}")
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: e.toString())
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val file = resolve(call) ?: return
        file.delete() // a missing file is not an error
        call.resolve()
    }
}
