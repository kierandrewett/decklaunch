package dev.kieran.decklaunch

import android.Manifest
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.*
import android.widget.Button
import android.widget.TextView
import androidx.activity.addCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var errorOverlay: View
    private lateinit var errorText: TextView
    private lateinit var retryButton: Button

    private val prefs by lazy { getSharedPreferences("decklaunch", MODE_PRIVATE) }

    // Return to the launcher whenever the screen wakes while we're not in the foreground.
    // This handles "inactivity" correctly: actively using another app never interrupts you;
    // only picking up the phone after it went idle/dark brings the launcher back.
    private val screenOnReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_SCREEN_ON && !hasWindowFocus()) {
                val serverUrl = prefs.getString("server_url", "") ?: ""
                val token = prefs.getString("auth_token", "") ?: ""
                if (::webView.isInitialized) loadPanel(serverUrl, token)
                startActivity(Intent(context, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or
                             Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                             Intent.FLAG_ACTIVITY_SINGLE_TOP)
                })
            }
        }
    }

    // Secret escape gesture: hold 3 fingers for 2 seconds → open launcher settings
    private var threeFingerDownAt = 0L

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.pointerCount == 3) threeFingerDownAt = System.currentTimeMillis()
            }
            MotionEvent.ACTION_MOVE -> {
                if (event.pointerCount >= 3 && threeFingerDownAt > 0 &&
                    System.currentTimeMillis() - threeFingerDownAt > 2000
                ) {
                    threeFingerDownAt = 0
                    showOptionsMenu()
                    return true
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> threeFingerDownAt = 0
        }
        return super.dispatchTouchEvent(event)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Check if setup is needed
        val serverUrl = prefs.getString("server_url", null)
        val token = prefs.getString("auth_token", null)
        if (serverUrl.isNullOrBlank() || token.isNullOrBlank()) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)
        setupImmersive()

        webView = findViewById(R.id.webview)
        errorOverlay = findViewById(R.id.error_overlay)
        errorText = findViewById(R.id.error_text)
        retryButton = findViewById(R.id.retry_button)

        setupWebView(serverUrl, token)

        retryButton.setOnClickListener {
            errorOverlay.visibility = View.GONE
            loadPanel(serverUrl, token)
        }

        findViewById<Button>(R.id.settings_button).setOnClickListener {
            showSetup()
        }
    }

    private fun setupImmersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.insetsController?.let { ctrl ->
            ctrl.hide(WindowInsets.Type.systemBars())
            ctrl.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        window.attributes = window.attributes.also {
            it.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun setupWebView(serverUrl: String, token: String) {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = false
            displayZoomControls = false
            setSupportZoom(false)
            mediaPlaybackRequiresUserGesture = false
        }

        webView.addJavascriptInterface(NativeBridge(this), "Native")

        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    scheduleReload(serverUrl, token)
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                errorOverlay.visibility = View.GONE
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val toGrant = request.resources
                    .filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                    .toTypedArray()
                if (toGrant.isNotEmpty()) request.grant(toGrant) else request.deny()
            }
        }

        onBackPressedDispatcher.addCallback(this) {
            if (webView.canGoBack()) webView.goBack()
            // else do nothing — don't exit the launcher
        }

        loadPanel(serverUrl, token)
        requestAppPermissions()
        registerReceiver(screenOnReceiver, IntentFilter(Intent.ACTION_SCREEN_ON))
    }

    override fun onDestroy() {
        super.onDestroy()
        unregisterReceiver(screenOnReceiver)
    }

    private fun requestAppPermissions() {
        val needed = arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.RECORD_AUDIO)
            .filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
            .toTypedArray()
        if (needed.isNotEmpty()) ActivityCompat.requestPermissions(this, needed, 1001)
    }

    private fun scheduleReload(serverUrl: String, token: String) {
        webView.postDelayed({ loadPanel(serverUrl, token) }, 3000)
    }

    private fun loadPanel(serverUrl: String, token: String) {
        val url = "${serverUrl.trimEnd('/')}/?token=${token}"
        webView.loadUrl(url)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Home button pressed — always navigate back to the panel
        if (::webView.isInitialized) {
            val serverUrl = prefs.getString("server_url", "") ?: ""
            val token = prefs.getString("auth_token", "") ?: ""
            loadPanel(serverUrl, token)
        }
    }

    fun showError(message: String) {
        runOnUiThread {
            errorText.text = message
            errorOverlay.visibility = View.VISIBLE
        }
    }

    private fun showOptionsMenu() {
        val token = prefs.getString("auth_token", "") ?: ""
        val serverUrl = prefs.getString("server_url", "") ?: ""
        AlertDialog.Builder(this)
            .setItems(arrayOf("Open config", "Change launcher", "Debug overlay")) { _, which ->
                when (which) {
                    0 -> webView.loadUrl("${serverUrl.trimEnd('/')}/config?token=${token}")
                    1 -> startActivity(Intent(Settings.ACTION_HOME_SETTINGS))
                    2 -> webView.evaluateJavascript("window.toggleDebug()", null)
                }
            }
            .show()
    }

    override fun onResume() {
        super.onResume()
        enableDnd()
    }

    override fun onPause() {
        super.onPause()
        disableDnd()
    }

    private fun notificationManager() =
        getSystemService(NOTIFICATION_SERVICE) as NotificationManager

    private fun enableDnd() {
        val nm = notificationManager()
        if (!nm.isNotificationPolicyAccessGranted) {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS))
            return
        }
        nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALARMS)
    }

    private fun disableDnd() {
        val nm = notificationManager()
        if (nm.isNotificationPolicyAccessGranted) {
            nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALL)
        }
    }

    fun showSetup() {
        startActivity(Intent(this, SetupActivity::class.java))
    }
}
