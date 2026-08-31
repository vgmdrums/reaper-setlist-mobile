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
import androidx.lifecycle.lifecycleScope
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * First-run (and re-pair) screen. Three ways in:
 *  1. Scan the tray app's QR code — encodes {"host","port","token"} directly
 *     (see companion/pairing.py's build_pairing_payload()).
 *  2. Type the stable pairing phrase shown in the tray app — this app
 *     broadcasts it on the Wi-Fi network via DiscoveryClient and the
 *     companion answers with the real host/port/token.
 *  3. Paste the raw QR JSON by hand, for when the camera can't be used.
 * The manual field accepts either a phrase or JSON and figures out which.
 */
class PairingActivity : AppCompatActivity() {

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let { handlePairingText(it) }
    }

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

        findViewById<Button>(R.id.scanButton).setOnClickListener {
            if (requireDeviceName() == null) return@setOnClickListener
            scanLauncher.launch(ScanOptions().apply {
                setPrompt(getString(R.string.scan_qr))
                setBeepEnabled(false)
                setOrientationLocked(true)
            })
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

        val fromJson = parsePairingPayload(trimmed)
        if (fromJson != null) {
            errorText.visibility = View.GONE
            savePairingAndStart(fromJson)
            return
        }

        // Not JSON — treat it as a pairing phrase and try to discover the
        // companion on the local Wi-Fi network.
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

    private fun parsePairingPayload(raw: String): PairingInfo? {
        return try {
            val json = JSONObject(raw)
            PairingInfo(
                host = json.getString("host"),
                port = json.getInt("port"),
                token = json.getString("token"),
            )
        } catch (e: Exception) {
            null
        }
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
