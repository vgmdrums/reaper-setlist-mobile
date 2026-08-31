package com.geniusapps.setlistmobile

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

private const val DISCOVERY_PORT = 47823

/**
 * Finds the companion by pairing phrase instead of scanning its QR code.
 * Broadcasts {"discover": "<phrase>"} on the Wi-Fi network; the companion's
 * UDP listener (main.py: start_discovery_server) replies with the real
 * {host, port, token} only if the phrase matches — the phrase itself is
 * never the session credential, just how we find the right PC.
 */
object DiscoveryClient {

    suspend fun findByPhrase(phrase: String, timeoutMs: Int = 3000): PairingInfo? =
        withContext(Dispatchers.IO) {
            try {
                DatagramSocket().use { socket ->
                    socket.broadcast = true
                    socket.soTimeout = timeoutMs

                    val request = JSONObject().put("discover", phrase).toString().toByteArray()
                    socket.send(DatagramPacket(
                        request, request.size,
                        InetAddress.getByName("255.255.255.255"), DISCOVERY_PORT,
                    ))

                    val buf = ByteArray(1024)
                    val replyPacket = DatagramPacket(buf, buf.size)
                    socket.receive(replyPacket)

                    val json = JSONObject(String(replyPacket.data, 0, replyPacket.length))
                    PairingInfo(
                        host = json.getString("host"),
                        port = json.getInt("port"),
                        token = json.getString("token"),
                    )
                }
            } catch (e: Exception) {
                null
            }
        }
}
