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
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
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
                        R.id.action_reload -> { webView.reload(); true }
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
            webView.loadUrl(info.baseUrl() + "?token=" + info.token + "&device_label=" + encodedLabel)
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
