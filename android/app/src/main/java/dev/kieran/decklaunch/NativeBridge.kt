package dev.kieran.decklaunch

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.provider.CalendarContract
import android.provider.Settings
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.util.Base64
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class NativeBridge(private val context: Context) {

    /**
     * Returns JSON array of installed apps:
     * [{ "packageName": "...", "appName": "...", "iconBase64": "..." }]
     */
    @JavascriptInterface
    fun getInstalledApps(): String {
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
        }
        @Suppress("DEPRECATION")
        val apps = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0L))
        } else {
            pm.queryIntentActivities(intent, 0)
        }
        val arr = JSONArray()
        for (info in apps) {
            try {
                val appInfo = info.activityInfo.applicationInfo
                val name = pm.getApplicationLabel(appInfo).toString()
                val pkg = appInfo.packageName
                val icon = pm.getApplicationIcon(appInfo)
                val iconB64 = drawableToBase64(icon)
                arr.put(JSONObject().apply {
                    put("packageName", pkg)
                    put("appName", name)
                    put("iconBase64", iconB64)
                })
            } catch (e: Exception) {
                // skip apps that fail
            }
        }
        return arr.toString()
    }

    /**
     * Returns base64-encoded PNG icon for a single package, or "" if not found.
     */
    @JavascriptInterface
    fun getAppIcon(packageName: String): String {
        return try {
            val pm = context.packageManager
            val icon = pm.getApplicationIcon(packageName)
            drawableToBase64(icon)
        } catch (e: Exception) {
            ""
        }
    }

    /**
     * Launches an app by package name.
     */
    @JavascriptInterface
    fun launchApp(packageName: String) {
        val intent = context.packageManager.getLaunchIntentForPackage(packageName)
        if (intent != null) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
    }

    /**
     * Returns JSON with device info:
     * { "deviceName": "...", "batteryLevel": 85, "wifiSsid": "...", "model": "..." }
     */
    @JavascriptInterface
    fun getDeviceInfo(): String {
        val batteryLevel = getBatteryLevel()
        val wifiSsid = getWifiSsid()
        return JSONObject().apply {
            put("deviceName", Build.MODEL)
            put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            put("batteryLevel", batteryLevel)
            put("wifiSsid", wifiSsid)
        }.toString()
    }

    /**
     * Returns now-playing info from the MediaSessionService.
     * { "title": "...", "artist": "...", "album": "...", "state": "playing|paused|stopped",
     *   "albumArtBase64": "..." }
     * Returns null/empty if nothing playing.
     */
    @JavascriptInterface
    fun getNowPlaying(): String {
        val service = MediaSessionService.instance
        return service?.getNowPlayingJson() ?: JSONObject().apply {
            put("title", "")
            put("artist", "")
            put("album", "")
            put("state", "stopped")
            put("albumArtBase64", "")
        }.toString()
    }

/**
     * Controls media playback.
     * action: "play", "pause", "next", "previous"
     */
    @JavascriptInterface
    fun mediaControl(action: String) {
        MediaSessionService.instance?.sendMediaAction(action)
    }

    /**
     * Returns available calendars: [{ "id": "...", "name": "...", "accountName": "..." }]
     */
    @JavascriptInterface
    fun getCalendars(): String {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR)
            != PackageManager.PERMISSION_GRANTED) return "[]"
        val uri = CalendarContract.Calendars.CONTENT_URI
        val projection = arrayOf(
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
            CalendarContract.Calendars.ACCOUNT_NAME,
        )
        val cursor = context.contentResolver.query(uri, projection, null, null, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME)
        val arr = JSONArray()
        cursor?.use {
            while (it.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id",          it.getLong(0).toString())
                    put("name",        it.getString(1) ?: "")
                    put("accountName", it.getString(2) ?: "")
                })
            }
        }
        return arr.toString()
    }

    /**
     * Returns upcoming calendar event instances filtered by calendarId (empty = all) and days.
     * Uses CalendarContract.Instances so recurring events are correctly expanded.
     */
    @JavascriptInterface
    fun getCalendarEventsEx(calendarId: String, days: Int): String {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR)
            != PackageManager.PERMISSION_GRANTED) return "[]"
        val now = System.currentTimeMillis()
        val end = now + days.toLong() * 24 * 60 * 60 * 1000
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon()
            .also { ContentUris.appendId(it, now); ContentUris.appendId(it, end) }
            .build()
        val projection = arrayOf(
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
            CalendarContract.Instances.CALENDAR_ID,
        )
        val (selection, selArgs) = if (calendarId.isNotBlank())
            "${CalendarContract.Instances.CALENDAR_ID} = ?" to arrayOf(calendarId)
        else
            null to null
        val cursor = context.contentResolver.query(
            uri, projection, selection, selArgs,
            "${CalendarContract.Instances.BEGIN} ASC"
        )
        val arr = JSONArray()
        val timeFmt = SimpleDateFormat("HH:mm", Locale.getDefault())
        val dateFmt = SimpleDateFormat("EEE dd MMM", Locale.getDefault())
        cursor?.use {
            var count = 0
            while (it.moveToNext() && count < 60) {
                val title   = it.getString(0) ?: continue
                val startMs = it.getLong(1)
                val endMs   = it.getLong(2)
                val allDay  = it.getInt(3) == 1
                val cal     = it.getString(4) ?: ""
                val date    = Date(startMs)
                arr.put(JSONObject().apply {
                    put("title",    title)
                    put("start",    if (allDay) "All day" else timeFmt.format(date))
                    put("end",      if (allDay) "" else timeFmt.format(Date(endMs)))
                    put("day",      dateFmt.format(date))
                    put("startMs",  startMs)
                    put("endMs",    endMs)
                    put("allDay",   allDay)
                    put("calendar", cal)
                })
                count++
            }
        }
        return arr.toString()
    }

    /**
     * Returns next 10 event instances within 7 days.
     * Uses CalendarContract.Instances so recurring events are correctly expanded.
     */
    @JavascriptInterface
    fun getCalendarEvents(): String {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR)
            != PackageManager.PERMISSION_GRANTED) return "[]"
        val now = System.currentTimeMillis()
        val end = now + 7L * 24 * 60 * 60 * 1000
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon()
            .also { ContentUris.appendId(it, now); ContentUris.appendId(it, end) }
            .build()
        val projection = arrayOf(
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
        )
        val cursor = context.contentResolver.query(
            uri, projection, null, null,
            "${CalendarContract.Instances.BEGIN} ASC"
        )
        val arr = JSONArray()
        val timeFmt = SimpleDateFormat("HH:mm", Locale.getDefault())
        val dateFmt = SimpleDateFormat("EEE", Locale.getDefault())
        cursor?.use {
            var count = 0
            while (it.moveToNext() && count < 10) {
                val title   = it.getString(0) ?: continue
                val startMs = it.getLong(1)
                val allDay  = it.getInt(2) == 1
                val cal     = it.getString(3) ?: ""
                val date    = Date(startMs)
                arr.put(JSONObject().apply {
                    put("title",    title)
                    put("start",    if (allDay) "All day" else timeFmt.format(date))
                    put("day",      dateFmt.format(date))
                    put("startMs",  startMs)
                    put("allDay",   allDay)
                    put("calendar", cal)
                })
                count++
            }
        }
        return arr.toString()
    }

    /**
     * Returns true if the device microphone is NOT muted.
     */
    @JavascriptInterface
    fun isMicActive(): Boolean {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        return !am.isMicrophoneMute
    }

    // ── Native mic level ─────────────────────────────────────────────────────────

    private var audioRecord: AudioRecord? = null
    private var micThread: Thread? = null
    @Volatile private var micLevel: Float = 0f
    @Volatile private var micRunning = false

    /**
     * Starts a background thread that continuously samples the microphone
     * and updates micLevel (0.0–1.0 RMS).
     */
    @JavascriptInterface
    fun startMicMonitor() {
        if (micRunning) return
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) return
        micRunning = true
        val sampleRate = 44100
        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(4096)
        try {
            val ar = AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf * 2
            )
            if (ar.state != AudioRecord.STATE_INITIALIZED) { micRunning = false; return }
            audioRecord = ar
            ar.startRecording()
            micThread = Thread {
                val buf = ShortArray(minBuf / 2)
                while (micRunning) {
                    val n = ar.read(buf, 0, buf.size)
                    if (n > 0) {
                        var sum = 0.0
                        for (i in 0 until n) { val s = buf[i] / 32768.0; sum += s * s }
                        micLevel = (Math.sqrt(sum / n) * 15.0).toFloat().coerceIn(0f, 1f)
                    }
                }
            }.also { it.isDaemon = true; it.start() }
        } catch (_: Exception) { micRunning = false }
    }

    @JavascriptInterface
    fun stopMicMonitor() {
        micRunning = false
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        micLevel = 0f
    }

    /**
     * Returns the current RMS mic level (0.0–1.0). Returns 0 when muted.
     */
    @JavascriptInterface
    fun getMicLevel(): Float {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        return if (am.isMicrophoneMute) 0f else micLevel
    }

    /**
     * Returns true if audio is currently playing through this device's output
     * (uses AudioManager.isMusicActive — hardware-level check, not session state).
     */
    @JavascriptInterface
    fun isMusicActive(): Boolean {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        return am.isMusicActive
    }

    /**
     * Returns the current media stream volume as 0–100.
     */
    @JavascriptInterface
    fun getVolume(): Int {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val current = am.getStreamVolume(AudioManager.STREAM_MUSIC)
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        return if (max > 0) (current * 100 / max) else 0
    }

    /**
     * Sets the media stream volume (0–100).
     */
    @JavascriptInterface
    fun setVolume(level: Int) {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val vol = (level.coerceIn(0, 100) * max / 100)
        am.setStreamVolume(AudioManager.STREAM_MUSIC, vol, 0)
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────

    private fun getBatteryLevel(): Int {
        val intentFilter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val batteryStatus = context.registerReceiver(null, intentFilter)
        val level = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        return if (level >= 0 && scale > 0) (level * 100 / scale) else -1
    }

    private fun getWifiSsid(): String {
        return try {
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val info = wm.connectionInfo
            info.ssid?.removeSurrounding("\"") ?: ""
        } catch (e: Exception) {
            ""
        }
    }

    private fun drawableToBase64(drawable: Drawable): String {
        return try {
            val bmp = Bitmap.createBitmap(48, 48, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bmp)
            drawable.setBounds(0, 0, canvas.width, canvas.height)
            drawable.draw(canvas)
            val baos = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.PNG, 80, baos)
            Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
        } catch (e: Exception) {
            ""
        }
    }
}
