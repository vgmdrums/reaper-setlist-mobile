package com.geniusapps.setlistmobile

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Talking to the companion over the USB cable. While this phone is plugged in
 * with USB debugging authorized, the companion keeps `adb reverse` running
 * (see companion/main.py's usb_tether_loop), so 127.0.0.1:<port> on THIS phone
 * reaches the companion on the PC. Nothing listens there otherwise, so every
 * call here fails instantly (connection refused) when there's no cable.
 */
object UsbLink {
    const val DEFAULT_PORT = 9760

    /**
     * The pairing info the companion hands to a phone on the other end of its
     * USB tunnel — the same host/port/token a QR code carries — or null when
     * there's no tunnel (or an older companion without /usb-pair). `host` in
     * the result is the PC's LAN address: what to fall back to when the cable
     * comes out. The connection itself should use 127.0.0.1.
     */
    suspend fun fetchPairing(port: Int = DEFAULT_PORT): PairingInfo? = withContext(Dispatchers.IO) {
        var conn: HttpURLConnection? = null
        try {
            conn = URL("http://127.0.0.1:$port/usb-pair").openConnection() as HttpURLConnection
            conn.connectTimeout = 500
            conn.readTimeout = 1000
            conn.requestMethod = "GET"
            if (conn.responseCode !in 200..299) return@withContext null
            val json = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            PairingInfo(json.getString("host"), json.getInt("port"), json.getString("token"))
        } catch (e: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    /**
     * Whether a companion that already knows this token answers over the
     * tunnel. Only for companions older than /usb-pair, which still tunnel but
     * can't hand out pairing info — a phone already paired to one still
     * prefers the cable.
     */
    suspend fun reachableWith(port: Int, token: String): Boolean = withContext(Dispatchers.IO) {
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
}
