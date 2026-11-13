package com.vibetv.app

import android.content.pm.ActivityInfo
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.annotation.OptIn
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * The player on Android: Media3 ExoPlayer, which opens stream addresses itself (so the limits of a
 * web page don't apply), sends each channel's Referer / User-Agent, and decodes with the device's
 * own decoders.
 *
 * The picture is drawn *behind* the web page, in the rectangle the page says its player occupies.
 * The page is see-through there, so everything it draws (controls, sidebar, quick search) stays on
 * top of the video, exactly as on a computer. platform/android/player.js is the other half.
 *
 * Events sent to the page: "state" { session, state, position, duration, live, width, height },
 * "error" { session, reason, detail }, "tracks" { session, noSound, noPicture, audio, video }.
 */
@OptIn(UnstableApi::class)
@CapacitorPlugin(name = "VibePlayer")
class VibePlayerPlugin : Plugin() {
    private class Request(val url: String, val userAgent: String?, val referrer: String?, val kind: String, val session: Int)

    private val ui = Handler(Looper.getMainLooper())
    private var host: FrameLayout? = null
    private var view: PlayerView? = null
    private var player: ExoPlayer? = null
    private var current: Request? = null
    private var triedAsHls = false
    private var volume = 1f
    private var resumeWhenBack = false
    private val ticker = object : Runnable {
        override fun run() {
            val p = player ?: return
            if (p.isPlaying) emitState(if (p.isPlaying) "playing" else "paused")
            ui.postDelayed(this, 500)
        }
    }

    override fun load() {
        ui.post {
            val web = bridge.webView
            val parent = web.parent as? ViewGroup ?: return@post
            web.setBackgroundColor(Color.TRANSPARENT)
            val box = FrameLayout(context)
            box.setBackgroundColor(Color.BLACK)
            val pv = PlayerView(context)
            pv.useController = false
            pv.resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            pv.setShutterBackgroundColor(Color.BLACK)
            box.addView(pv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            parent.addView(box, 0, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            host = box
            view = pv
        }
    }

    /* ───────────── calls from the page ───────────── */

    @PluginMethod
    fun play(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("No address")
        // Network streams only: a playlist must not point the player at file://, content:// or
        // asset:// and so at files on the device.
        val scheme = android.net.Uri.parse(url).scheme?.lowercase()
        if (scheme !in setOf("http", "https", "rtsp", "udp")) return call.reject("This kind of stream address isn't supported", "protocol-other")
        val req = Request(url, call.getString("userAgent"), call.getString("referrer"), call.getString("kind") ?: "", call.getInt("session") ?: 0)
        ui.post {
            try {
                start(req, false)
                call.resolve()
            } catch (e: Exception) {
                call.reject(e.message ?: e.toString())
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        ui.post { release(); call.resolve() }
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        ui.post { player?.pause(); call.resolve() }
    }

    @PluginMethod
    fun resume(call: PluginCall) {
        ui.post {
            player?.let { p ->
                // A live channel that was paused continues from now, not from where it stopped.
                if (p.isCurrentMediaItemLive || p.duration == C.TIME_UNSET) p.seekToDefaultPosition()
                if (p.playbackState == Player.STATE_IDLE) p.prepare()
                p.play()
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun seek(call: PluginCall) {
        val seconds = call.getDouble("position") ?: 0.0
        ui.post { player?.seekTo((seconds * 1000).toLong()); call.resolve() }
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val muted = call.getBoolean("muted") ?: false
        volume = if (muted) 0f else (call.getDouble("volume") ?: 1.0).toFloat().coerceIn(0f, 1f)
        ui.post { player?.volume = volume; call.resolve() }
    }

    /** Where the page's player is, in CSS pixels from the top left of the page. */
    @PluginMethod
    fun setRect(call: PluginCall) {
        val d = context.resources.displayMetrics.density
        val px = { name: String -> ((call.getDouble(name) ?: 0.0) * d).toInt() }
        ui.post {
            val lp = FrameLayout.LayoutParams(px("width").coerceAtLeast(1), px("height").coerceAtLeast(1))
            lp.leftMargin = px("x")
            lp.topMargin = px("y")
            view?.layoutParams = lp
            call.resolve()
        }
    }

    /** Full screen: hides the system bars, and on a phone turns the screen sideways. */
    @PluginMethod
    fun setImmersive(call: PluginCall) {
        val on = call.getBoolean("on") ?: false
        val sideways = call.getBoolean("landscape") ?: false
        ui.post {
            val window = activity.window
            val bars = WindowCompat.getInsetsController(window, window.decorView)
            if (on) {
                bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                bars.hide(WindowInsetsCompat.Type.systemBars())
            } else {
                bars.show(WindowInsetsCompat.Type.systemBars())
            }
            activity.requestedOrientation = if (on && sideways) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            call.resolve()
        }
    }

    /* ───────────── the player ───────────── */

    private fun start(req: Request, asHls: Boolean) {
        release()
        current = req
        triedAsHls = asHls

        val headers = HashMap<String, String>()
        req.referrer?.takeIf { it.isNotEmpty() }?.let {
            headers["Referer"] = it
            runCatching { java.net.URL(it) }.getOrNull()?.let { u -> headers["Origin"] = u.protocol + "://" + u.authority }
        }
        val http = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(20000)
            // Without one of its own, a channel is asked for like the desktop app asks: as a browser.
            .setUserAgent(req.userAgent?.takeIf { it.isNotEmpty() } ?: bridge.webView.settings.userAgentString)
            .setDefaultRequestProperties(headers)
        val sources = DefaultMediaSourceFactory(
            DefaultDataSource.Factory(context, http), // also opens udp:// and files
            DefaultExtractorsFactory()
                .setConstantBitrateSeekingEnabled(true)
                // IPTV MPEG-TS is often cut anywhere and marks its keyframes loosely.
                .setTsExtractorFlags(DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES or DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS)
        )
        val p = ExoPlayer.Builder(context, DefaultRenderersFactory(context).setEnableDecoderFallback(true))
            .setMediaSourceFactory(sources)
            .build()
        p.setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true) // pauses for calls, other apps
        p.setHandleAudioBecomingNoisy(true) // pauses when headphones are pulled out
        p.volume = volume

        val mime = when {
            asHls || req.kind == "hls" -> MimeTypes.APPLICATION_M3U8
            req.kind == "dash" -> MimeTypes.APPLICATION_MPD
            else -> null // by the address and the first bytes: MPEG-TS, MP4, MKV, rtsp://, ...
        }
        val item = MediaItem.Builder().setUri(req.url)
        if (mime != null) item.setMimeType(mime)

        p.addListener(Events(req))
        view?.player = p
        p.setMediaItem(item.build())
        p.playWhenReady = true
        p.prepare()
        player = p
        ui.removeCallbacks(ticker)
        ui.postDelayed(ticker, 500)
    }

    private fun release() {
        ui.removeCallbacks(ticker)
        view?.player = null
        view?.keepScreenOn = false
        player?.release()
        player = null
        current = null
    }

    private inner class Events(val req: Request) : Player.Listener {
        private fun mine() = current === req

        override fun onPlaybackStateChanged(state: Int) {
            if (!mine()) return
            val p = player ?: return
            when (state) {
                Player.STATE_BUFFERING -> emitState("buffering")
                Player.STATE_READY -> emitState(if (p.playWhenReady) "playing" else "paused")
                Player.STATE_ENDED -> emitState("ended")
                else -> {}
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (!mine()) return
            view?.keepScreenOn = isPlaying // the screen stays on while a channel plays
            val p = player ?: return
            if (p.playbackState == Player.STATE_READY) emitState(if (isPlaying) "playing" else "paused")
        }

        override fun onVideoSizeChanged(size: VideoSize) {
            if (mine()) emitState(null)
        }

        // A stream can start while part of it has no decoder on this device (AC-3 sound is the usual case).
        override fun onTracksChanged(tracks: Tracks) {
            if (!mine()) return
            val lost = { type: Int -> tracks.containsType(type) && !tracks.isTypeSupported(type, true) }
            val name = { type: Int ->
                tracks.groups.firstOrNull { it.type == type }?.let { g -> g.getTrackFormat(0).let { it.codecs ?: it.sampleMimeType } } ?: ""
            }
            notifyListeners(
                "tracks",
                JSObject().put("session", req.session)
                    .put("noSound", lost(C.TRACK_TYPE_AUDIO)).put("noPicture", lost(C.TRACK_TYPE_VIDEO))
                    .put("audio", name(C.TRACK_TYPE_AUDIO)).put("video", name(C.TRACK_TYPE_VIDEO))
            )
        }

        override fun onPlayerError(error: PlaybackException) {
            if (!mine()) return
            val code = error.errorCode
            // Not what the address looked like: many HLS channels have no ".m3u8" in their address.
            if (!triedAsHls && req.kind.isEmpty() && code in 3000..3999) {
                start(req, true)
                return
            }
            // A live channel that fell out of its window continues from the newest part.
            if (code == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                player?.let { it.seekToDefaultPosition(); it.prepare() }
                return
            }
            val reason = when (code) {
                PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "timeout"
                in 2000..2999 -> "offline"
                else -> "unsupported" // 3000s: not a stream this player reads; 4000s and 5000s: no decoder for it
            }
            val cause = error.cause?.message?.takeIf { it.isNotBlank() }
            notifyListeners(
                "error",
                JSObject().put("session", req.session).put("reason", reason)
                    .put("detail", error.errorCodeName + (cause?.let { ": $it" } ?: ""))
            )
        }
    }

    // state = null: nothing changed but the numbers (picture size, position).
    private fun emitState(state: String?) {
        val p = player ?: return
        val req = current ?: return
        val duration = p.duration
        val live = p.isCurrentMediaItemLive || duration == C.TIME_UNSET
        val o = JSObject().put("session", req.session)
            .put("position", p.currentPosition / 1000.0)
            .put("duration", if (duration == C.TIME_UNSET) -1.0 else duration / 1000.0)
            .put("live", live)
            .put("width", p.videoSize.width).put("height", p.videoSize.height)
        if (state != null) o.put("state", state)
        notifyListeners("state", o)
    }

    /* ───────────── the app going away and coming back ───────────── */

    override fun handleOnPause() {
        val p = player ?: return
        resumeWhenBack = p.isPlaying || (p.playWhenReady && p.playbackState == Player.STATE_BUFFERING)
        p.pause()
    }

    override fun handleOnResume() {
        val p = player ?: return
        if (!resumeWhenBack) return
        resumeWhenBack = false
        if (p.isCurrentMediaItemLive || p.duration == C.TIME_UNSET) p.seekToDefaultPosition()
        if (p.playbackState == Player.STATE_IDLE) p.prepare()
        p.play()
    }

    override fun handleOnDestroy() {
        release()
    }
}
