package com.geniusapps.setlistmobile

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageButton
import android.widget.PopupMenu
import android.widget.ProgressBar
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * The whole app, really: a full-screen WebView pointed at the companion's
 * mobile-optimized frontend. The pairing token travels once in the URL query
 * string (?token=...); the page itself reads it, stores it in localStorage,
 * and strips it from the address bar — see the PAIR_TOKEN bootstrap at the
 * top of frontend/src/App.jsx.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        enableFullscreen()

        webView = findViewById(R.id.webView)
        val spinner = findViewById<ProgressBar>(R.id.loadingSpinner)

        // setDecorFitsSystemWindows(false) above means the app draws under
        // the status bar / notch itself — fine since those bars are hidden,
        // but a physical camera cutout is still there and can clip content
        // (like the Stage view's REAPER banner) that sits flush at the very
        // top of the page. Pad the WebView by exactly the cutout's inset so
        // nothing renders underneath it, while everything else still uses
        // the full edge-to-edge screen.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            view.updatePadding(top = cutout.top)
            insets
        }

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                spinner.visibility = View.GONE
            }
        }

        findViewById<ImageButton>(R.id.menuButton).setOnClickListener { anchor ->
            PopupMenu(this, anchor).apply {
                menuInflater.inflate(R.menu.main_menu, menu)
                setOnMenuItemClickListener { item ->
                    when (item.itemId) {
                        // Re-runs the USB-vs-Wi-Fi resolution (not just a
                        // same-origin webView.reload()) so plugging/unplugging
                        // the cable mid-session takes effect on demand.
                        R.id.action_reload -> { loadFromSavedPairing(); true }
                        R.id.action_repair -> { rePair(); true }
                        else -> false
                    }
                }
            }.show()
        }

        loadFromSavedPairing()
    }

    private fun loadFromSavedPairing() {
        lifecycleScope.launch {
            val info = PairingStore.get(this@MainActivity)
            if (info == null) {
                goToPairing()
                return@launch
            }
            val label = PairingStore.getDeviceLabel(this@MainActivity) ?: ""
            val encodedLabel = URLEncoder.encode(label, "UTF-8")
            // The companion keeps `adb reverse tcp:port tcp:port` alive
            // automatically whenever this phone is plugged in with USB
            // debugging authorized (see main.py's usb_tether_loop) — when
            // that's active, 127.0.0.1 on THIS phone forwards over the
            // cable to the companion PC. Try it first; if nothing answers
            // there (no cable, debugging not authorized, companion not
            // tethering), fall back to the saved Wi-Fi host exactly as
            // before. A short timeout keeps the common Wi-Fi-only case from
            // feeling any slower at launch.
            val host = if (probeUsb(info.port, info.token)) "127.0.0.1" else info.host
            webView.loadUrl("http://$host:${info.port}/?token=${info.token}&device_label=$encodedLabel")
        }
    }

    private suspend fun probeUsb(port: Int, token: String): Boolean = withContext(Dispatchers.IO) {
        var conn: HttpURLConnection? = null
        try {
            conn = URL("http://127.0.0.1:$port/health?token=$token").openConnection() as HttpURLConnection
            conn.connectTimeout = 500
            conn.readTimeout = 500
            conn.requestMethod = "GET"
            conn.responseCode in 200..299
        } catch (e: Exception) {
            false
        } finally {
            conn?.disconnect()
        }
    }

    private fun rePair() {
        lifecycleScope.launch {
            PairingStore.clear(this@MainActivity)
            goToPairing()
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    /** Hides the status/nav bars — a swipe from the edge reveals them
     * briefly (BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE) without permanently
     * exiting fullscreen. */
    private fun enableFullscreen() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).let { controller ->
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enableFullscreen() // re-hide after a transient swipe-reveal or app resume
    }

    private fun goToPairing() {
        startActivity(Intent(this, PairingActivity::class.java))
        finish()
    }
}
