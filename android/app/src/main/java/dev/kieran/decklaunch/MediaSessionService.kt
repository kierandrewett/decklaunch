package dev.kieran.decklaunch

import android.graphics.Bitmap
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.service.notification.NotificationListenerService
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * NotificationListenerService that gives us access to active media sessions.
 * Must be granted "Notification access" in system settings.
 */
class MediaSessionService : NotificationListenerService() {

    companion object {
        @Volatile
        var instance: MediaSessionService? = null
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onDestroy() {
        super.onDestroy()
        if (instance === this) instance = null
    }

    fun getNowPlayingJson(): String {
        val controller = getActiveController() ?: return emptyJson()
        val metadata = controller.metadata
        val playback = controller.playbackState

        val title = metadata?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: ""
        val artist = metadata?.getString(MediaMetadata.METADATA_KEY_ARTIST)
            ?: metadata?.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST) ?: ""
        val album = metadata?.getString(MediaMetadata.METADATA_KEY_ALBUM) ?: ""

        val state = when (playback?.state) {
            PlaybackState.STATE_PLAYING -> "playing"
            PlaybackState.STATE_PAUSED -> "paused"
            else -> "stopped"
        }

        val albumArt = metadata?.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART)
            ?: metadata?.getBitmap(MediaMetadata.METADATA_KEY_ART)
        val albumArtBase64 = albumArt?.let { bitmapToBase64(it) } ?: ""

        return JSONObject().apply {
            put("title", title)
            put("artist", artist)
            put("album", album)
            put("state", state)
            put("albumArtBase64", albumArtBase64)
        }.toString()
    }

    fun sendMediaAction(action: String) {
        val controller = getActiveController() ?: return
        val transport = controller.transportControls
        when (action) {
            "play" -> transport.play()
            "pause" -> transport.pause()
            "next" -> transport.skipToNext()
            "previous" -> transport.skipToPrevious()
            "play_pause" -> {
                val state = controller.playbackState?.state
                if (state == PlaybackState.STATE_PLAYING) transport.pause()
                else transport.play()
            }
        }
    }

    private fun getActiveController(): MediaController? {
        return try {
            val manager = getSystemService(MEDIA_SESSION_SERVICE) as MediaSessionManager
            val sessions = manager.getActiveSessions(
                android.content.ComponentName(this, MediaSessionService::class.java)
            )
            // Prefer a playing session
            sessions.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING }
                ?: sessions.firstOrNull()
        } catch (e: Exception) {
            null
        }
    }

    private fun bitmapToBase64(bitmap: Bitmap): String {
        return try {
            val scaled = Bitmap.createScaledBitmap(bitmap, 64, 64, true)
            val baos = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, 70, baos)
            Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
        } catch (e: Exception) {
            ""
        }
    }

    private fun emptyJson() = JSONObject().apply {
        put("title", "")
        put("artist", "")
        put("album", "")
        put("state", "stopped")
        put("albumArtBase64", "")
    }.toString()
}
