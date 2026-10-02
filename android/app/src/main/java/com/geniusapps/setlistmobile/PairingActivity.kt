package com.geniusapps.setlistmobile

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * First-run (and re-pair) screen. Over Wi-Fi the only way in is the stable
 * pairing phrase shown in the tray app: this app broadcasts it on the network
 * via DiscoveryClient and the companion answers with the real host/port/token.
 *
 * Plugged in over USB (debugging authorized, companion running), none of that
 * is needed: this is the launcher activity, so on every launch it checks for
 * the cable first and goes straight to the app if it's there. If a cable
 * shows up while this screen is open, a "Connect w/ USB" button appears.
 */
class PairingActivity : AppCompatActivity() {

    companion object {
        /** Stay on this screen even if a USB connection is available — set on a
         * deliberate re-pair, and when a USB connection just failed to pan out. */
        const val EXTRA_SKIP_AUTO_USB = "skipAutoUsb"
    }

    // The companion's pairing info, while a USB tunnel to it is up (else null).
    private var usbPairing: PairingInfo? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pairing)
        enableFullscreen()

        // Already paired from a previous run (this activity is only reached
        // directly on a fresh install, or after an explicit re-pair) — skip
        // straight to the WebView, but only once this device also has a name
        // (an upgrade from an older install may have pairing info but no
        // name yet, since that field didn't exist before).
        lifecycleScope.launch {
            if (!intent.getBooleanExtra(EXTRA_SKIP_AUTO_USB, false) &&
                UsbLink.fetchPairing(PairingStore.get(this@PairingActivity)?.port ?: UsbLink.DEFAULT_PORT) != null) {
                startMain() // MainActivity fetches and saves the pairing itself
                return@launch
            }
            val savedLabel = PairingStore.getDeviceLabel(this@PairingActivity)
            if (!savedLabel.isNullOrBlank()) {
                findViewById<EditText>(R.id.deviceNameInput).setText(savedLabel)
            }
            if (PairingStore.get(this@PairingActivity) != null && !savedLabel.isNullOrBlank()) {
                startMain()
                return@launch
            }
            // Only reached when pairing hasn't succeeded yet (including a
            // retry after a failed/interrupted attempt) — pre-fill whatever
            // was typed last time so a flaky connection doesn't mean typing
            // the phrase from scratch on every retry.
            val lastInput = PairingStore.getLastManualInput(this@PairingActivity)
            if (!lastInput.isNullOrBlank()) {
                findViewById<EditText>(R.id.manualInput).setText(lastInput)
            }
        }

        // A cable plugged in (or pulled out) while this screen is open shows or
        // hides the button; checking only while the screen is actually visible.
        val usbButton = findViewById<Button>(R.id.usbButton)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (true) {
                    usbPairing = UsbLink.fetchPairing()
                    usbButton.visibility = if (usbPairing != null) View.VISIBLE else View.GONE
                    delay(2000)
                }
            }
        }
        usbButton.setOnClickListener {
            if (requireDeviceName() == null) return@setOnClickListener
            usbPairing?.let { savePairingAndStart(it) }
        }

        findViewById<Button>(R.id.connectButton).setOnClickListener {
            if (requireDeviceName() == null) return@setOnClickListener
            val raw = findViewById<EditText>(R.id.manualInput).text.toString()
            handlePairingText(raw)
        }
    }

    /** Returns the trimmed device name, or null (and shows an error) if it's blank. */
    private fun requireDeviceName(): String? {
        val name = findViewById<EditText>(R.id.deviceNameInput).text.toString().trim()
        if (name.isEmpty()) {
            showError(findViewById(R.id.errorText), getString(R.string.device_name_error))
            return null
        }
        return name
    }

    private fun handlePairingText(raw: String) {
        val trimmed = raw.trim()
        val errorText = findViewById<TextView>(R.id.errorText)
        val connectButton = findViewById<Button>(R.id.connectButton)

        // Remember it regardless of outcome — if this attempt fails (e.g.
        // the network issue that prompted this feature), the next attempt
        // starts from where you left off instead of a blank field.
        if (trimmed.isNotEmpty()) {
            lifecycleScope.launch { PairingStore.saveLastManualInput(this@PairingActivity, trimmed) }
        }

        // Look for the companion on the local Wi-Fi network by its phrase.
        if (trimmed.isEmpty()) {
            showError(errorText, getString(R.string.pairing_error_invalid))
            return
        }
        errorText.visibility = View.GONE
        connectButton.isEnabled = false
        connectButton.text = getString(R.string.pairing_searching)
        lifecycleScope.launch {
            val found = DiscoveryClient.findByPhrase(trimmed)
            connectButton.isEnabled = true
            connectButton.text = getString(R.string.pairing_connect)
            if (found == null) {
                showError(errorText, getString(R.string.pairing_error_not_found))
            } else {
                savePairingAndStart(found)
            }
        }
    }

    private fun savePairingAndStart(info: PairingInfo) {
        val name = requireDeviceName() ?: return
        lifecycleScope.launch {
            PairingStore.save(this@PairingActivity, info)
            PairingStore.saveDeviceLabel(this@PairingActivity, name)
            startMain()
        }
    }

    private fun showError(errorText: TextView, message: String) {
        errorText.text = message
        errorText.visibility = View.VISIBLE
    }

    private fun startMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun enableFullscreen() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).let { controller ->
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enableFullscreen()
    }
}
