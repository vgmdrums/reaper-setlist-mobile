package com.geniusapps.setlistmobile

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.graphics.Bitmap
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageButton
import android.widget.PopupMenu
import android.widget.ProgressBar
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.updatePadding
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
    // Off by default — fullscreen used to be forced on every launch; it's
    // now opt-in via the in-app menu, loaded from PairingStore below.
    private var fullscreenEnabled = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

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
        // Always fetch the page and its scripts fresh. This app is only a window onto
        // a companion on the same LAN (or USB cable), so the HTTP cache buys nothing
        // — and a stale copy of the page is how a phone ends up running an old UI
        // (e.g. missing a feature) long after the companion was updated.
        webView.settings.cacheMode = WebSettings.LOAD_NO_CACHE
        val menuButton = findViewById<ImageButton>(R.id.menuButton)
        // Hotkeys: a Bluetooth keyboard or page-turner pedal sends key presses (arrow keys, Page Up/Down...)
        // that the page's hotkeys listen for. Android only delivers them to the view that has focus, and an
        // arrow key otherwise just moves focus around — onto the little menu button, say. So: the menu
        // button is touch-only and never takes focus, and the WebView always owns it (see dispatchKeyEvent).
        menuButton.isFocusable = false
        menuButton.isFocusableInTouchMode = false
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.requestFocus()
        webView.webViewClient = object : WebViewClient() {
            // A page that hid the menu (the sheet-music viewer) mustn't leave it hidden after a reload.
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                menuButton.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView, url: String) {
                spinner.visibility = View.GONE
                view.requestFocus()   // a fresh page starts with the key presses going to it
            }
        }
        // The web app hides this overlay menu while a sheet-music chart is open: it
        // sits exactly where the chart viewer's close button is, and its Settings screen
        // has the same full screen toggle this menu does. What this exposes to the page is
        // showing/hiding that one button and the full screen setting; the WebView only
        // ever loads the paired companion's own pages.
        webView.addJavascriptInterface(object {
            @JavascriptInterface
            fun setMenuVisible(visible: Boolean) {
                runOnUiThread { menuButton.visibility = if (visible) View.VISIBLE else View.GONE }
            }

            @JavascriptInterface
            fun getFullscreen(): Boolean = fullscreenEnabled

            @JavascriptInterface
            fun setFullscreen(enabled: Boolean) {
                runOnUiThread { if (enabled != fullscreenEnabled) toggleFullscreen() }
            }
        }, "GeniusAndroid")

        onBackPressedDispatcher.addCallback(this, backCallback)

        menuButton.setOnClickListener { anchor ->
            PopupMenu(this, anchor).apply {
                menuInflater.inflate(R.menu.main_menu, menu)
                // Title reflects current state rather than relying on a
                // checkable menu item's checkmark, which some OEM skins
                // don't render visibly in a PopupMenu.
                menu.findItem(R.id.action_fullscreen).title =
                    getString(if (fullscreenEnabled) R.string.menu_fullscreen_off else R.string.menu_fullscreen_on)
                setOnMenuItemClickListener { item ->
                    when (item.itemId) {
                        // Re-runs the USB-vs-Wi-Fi resolution (not just a
                        // same-origin webView.reload()) so plugging/unplugging
                        // the cable mid-session takes effect on demand.
                        R.id.action_reload -> { loadFromSavedPairing(); true }
                        R.id.action_fullscreen -> { toggleFullscreen(); true }
                        R.id.action_repair -> { rePair(); true }
                        else -> false
                    }
                }
            }.show()
        }

        lifecycleScope.launch {
            fullscreenEnabled = PairingStore.getFullscreen(this@MainActivity)
            applyFullscreenSetting()
        }

        loadFromSavedPairing()
    }

    private fun toggleFullscreen() {
        fullscreenEnabled = !fullscreenEnabled
        lifecycleScope.launch { PairingStore.setFullscreen(this@MainActivity, fullscreenEnabled) }
        applyFullscreenSetting()
    }

    private fun applyFullscreenSetting() {
        if (fullscreenEnabled) enableFullscreen() else disableFullscreen()
    }

    private fun loadFromSavedPairing() {
        lifecycleScope.launch {
            val saved = PairingStore.get(this@MainActivity)
            // The companion keeps `adb reverse` alive whenever this phone is
            // plugged in with USB debugging authorized (see main.py's
            // usb_tether_loop), so 127.0.0.1 on THIS phone reaches the PC on
            // the other end of the cable — and that PC will hand us its own
            // pairing info there. So a phone on a cable needs no
            // phrase, and one moved to a different computer simply follows
            // the cable: the info is saved over whatever it had, keeping the
            // PC's LAN address as the fallback for when the cable comes out.
            // With no cable the refused connection is instant, so Wi-Fi-only
            // launches don't feel it.
            val usb = UsbLink.fetchPairing(saved?.port ?: UsbLink.DEFAULT_PORT)
            val info = usb ?: saved
            if (info == null) {
                goToPairing(skipAutoUsb = true)
                return@launch
            }
            if (usb != null && usb != saved) PairingStore.save(this@MainActivity, usb)
            val label = PairingStore.getDeviceLabel(this@MainActivity) ?: ""
            val encodedLabel = URLEncoder.encode(label, "UTF-8")
            // An older companion can't hand out pairing info but still
            // tunnels, so a phone already paired to one keeps preferring the
            // cable when it answers there.
            val host = if (usb != null || UsbLink.reachableWith(info.port, info.token)) "127.0.0.1" else info.host
            webView.loadUrl("http://$host:${info.port}/?token=${info.token}&device_label=$encodedLabel")
        }
    }

    private fun rePair() {
        lifecycleScope.launch {
            PairingStore.clear(this@MainActivity)
            goToPairing(skipAutoUsb = true)
        }
    }

    /** Back button / back gesture. On current Android a bare onBackPressed() override
     * is no longer called for gesture navigation, so this is a proper callback: it asks
     * the page to close whatever it has open on top (Settings, a chart, a drawer...,
     * see window.__geniusBack in the web app); if the page had nothing to close, go
     * back in the page's history, and failing that leave the app as usual. */
    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            webView.evaluateJavascript("window.__geniusBack ? window.__geniusBack() : false") { handled ->
                if (handled == "true") return@evaluateJavascript
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        }
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

    private fun disableFullscreen() {
        WindowCompat.setDecorFitsSystemWindows(window, true)
        WindowInsetsControllerCompat(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && fullscreenEnabled) enableFullscreen() // re-hide after a transient swipe-reveal or app resume
    }

    /** Key presses belong to the page (its hotkeys): if anything else — or nothing — has focus, give it back
     * to the WebView before the key is dispatched, so an arrow key isn't spent on moving Android's focus. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (!webView.hasFocus()) webView.requestFocus()
        return super.dispatchKeyEvent(event)
    }

    /** skipAutoUsb: this is a deliberate stop at the pairing screen (an explicit
     * re-pair, or a USB connection that didn't pan out) — don't let it
     * auto-connect over the cable and bounce straight back out. */
    private fun goToPairing(skipAutoUsb: Boolean) {
        startActivity(Intent(this, PairingActivity::class.java).putExtra(PairingActivity.EXTRA_SKIP_AUTO_USB, skipAutoUsb))
        finish()
    }
}
