package com.vibetv.app

import android.os.SystemClock
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import java.util.concurrent.Executors
import javax.net.ssl.SSLException

/**
 * HTTP requests made by the app itself rather than by the page: playlists, Xtream Codes servers and
 * channel checks. The page cannot make them, because those servers do not allow requests from other
 * sites (CORS) and some only answer to a particular Referer or User-Agent.
 *
 * request({ url, headers, timeout, maxBytes, sniff }) -> { status, url, contentType, body (base64), truncated }
 *   maxBytes: stop reading there (the answer is then marked truncated)
 *   sniff:    a channel check. A live stream never ends, so only its beginning is read: text playlists
 *             in full, MPEG-TS far enough to find its program map, anything else just a first taste.
 */
@CapacitorPlugin(name = "VibeHttp")
class VibeHttpPlugin : Plugin() {
    // Capacitor calls plugins one at a time; a channel check runs many requests at once.
    private val pool = Executors.newFixedThreadPool(16)

    @PluginMethod
    fun request(call: PluginCall) {
        val address = call.getString("url") ?: return call.reject("No address")
        val headers = call.getObject("headers") ?: JSObject()
        val timeout = (call.getInt("timeout") ?: 30000).coerceIn(1000, 600000)
        val maxBytes = (call.getInt("maxBytes") ?: 64 * 1024 * 1024).coerceIn(1024, 128 * 1024 * 1024) // never more than the page ever needs
        val sniff = call.getBoolean("sniff") ?: false

        pool.execute {
            var conn: HttpURLConnection? = null
            try {
                val deadline = SystemClock.elapsedRealtime() + timeout
                val left = { (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1).toInt() }
                var url = URL(address)
                var hops = 0
                var status: Int
                while (true) {
                    if (url.protocol != "http" && url.protocol != "https") throw IllegalArgumentException("Only http and https addresses can be opened")
                    conn = url.openConnection() as HttpURLConnection
                    conn.instanceFollowRedirects = false // followed here, so http <-> https redirects work too
                    conn.connectTimeout = left()
                    conn.readTimeout = minOf(left(), 10000)
                    for (name in headers.keys()) conn.setRequestProperty(name, headers.getString(name))
                    status = conn.responseCode
                    val next = conn.getHeaderField("Location")
                    if (status in intArrayOf(301, 302, 303, 307, 308) && next != null && hops < 8) {
                        url = URL(url, next)
                        conn.disconnect()
                        hops++
                        continue
                    }
                    break
                }

                val out = ByteArrayOutputStream()
                var truncated = false
                if (status in 200..299) {
                    val started = SystemClock.elapsedRealtime()
                    val buf = ByteArray(16 * 1024)
                    conn!!.inputStream.use { input ->
                        while (true) {
                            if (SystemClock.elapsedRealtime() > deadline) {
                                if (sniff && out.size() > 0) break
                                throw SocketTimeoutException()
                            }
                            val n = try {
                                input.read(buf)
                            } catch (e: SocketTimeoutException) {
                                if (sniff && out.size() > 0) break
                                throw e
                            }
                            if (n < 0) break
                            out.write(buf, 0, n)
                            if (out.size() >= maxBytes) {
                                truncated = true
                                break
                            }
                            if (sniff && out.size() >= 512 && enough(out, SystemClock.elapsedRealtime() - started)) break
                        }
                    }
                }
                val res = JSObject()
                    .put("status", status)
                    .put("url", conn!!.url.toString())
                    .put("contentType", conn.contentType ?: "")
                    .put("truncated", truncated)
                    .put("body", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
                call.resolve(res)
            } catch (e: Exception) {
                // Named so lib/net.js can say what happened in plain words.
                call.reject(
                    when (e) {
                        is SocketTimeoutException -> "Timed out"
                        is UnknownHostException -> "ENOTFOUND"
                        is ConnectException -> "ECONNREFUSED"
                        is SSLException -> "certificate: " + (e.message ?: "")
                        else -> e.message ?: e.toString()
                    }
                )
            } finally {
                conn?.disconnect()
            }
        }
    }

    // Has a channel check read enough of this answer? (The same rule as lib/probe.js readSome.)
    private fun enough(out: ByteArrayOutputStream, elapsed: Long): Boolean {
        val head = out.toByteArray().copyOf(minOf(out.size(), 32))
        val text = String(head, Charsets.ISO_8859_1).removePrefix("ï»¿").trimStart()
        if (text.startsWith("#EXT")) return false // a playlist: read all of it
        if (head[0] != 0x47.toByte()) return true // not MPEG-TS: the first bytes say what it is
        return out.size() >= 64 * 1024 || elapsed > 3000 // MPEG-TS: far enough for its program map
    }

    override fun handleOnDestroy() {
        pool.shutdownNow()
    }
}
