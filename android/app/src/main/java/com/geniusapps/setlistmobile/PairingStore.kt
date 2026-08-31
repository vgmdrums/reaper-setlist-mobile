package com.geniusapps.setlistmobile

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.pairingDataStore: DataStore<Preferences> by preferencesDataStore(name = "pairing")

/** host/port/token scanned from the tray app's QR code — see companion/pairing.py. */
data class PairingInfo(val host: String, val port: Int, val token: String) {
    fun baseUrl() = "http://$host:$port/"
}

object PairingStore {
    private val KEY_HOST = stringPreferencesKey("host")
    private val KEY_PORT = stringPreferencesKey("port")
    private val KEY_TOKEN = stringPreferencesKey("token")
    private val KEY_DEVICE_LABEL = stringPreferencesKey("deviceLabel")
    private val KEY_LAST_MANUAL_INPUT = stringPreferencesKey("lastManualInput")

    fun flow(context: Context): Flow<PairingInfo?> =
        context.pairingDataStore.data.map { prefs ->
            val host = prefs[KEY_HOST] ?: return@map null
            val port = prefs[KEY_PORT]?.toIntOrNull() ?: return@map null
            val token = prefs[KEY_TOKEN] ?: return@map null
            PairingInfo(host, port, token)
        }

    suspend fun get(context: Context): PairingInfo? = flow(context).first()

    suspend fun save(context: Context, info: PairingInfo) {
        context.pairingDataStore.edit { prefs ->
            prefs[KEY_HOST] = info.host
            prefs[KEY_PORT] = info.port.toString()
            prefs[KEY_TOKEN] = info.token
        }
    }

    /** Survives clear() (and re-pairing with a different computer) — this
     * phone is still "Kyle's Phone" no matter which PC it's talking to. */
    suspend fun getDeviceLabel(context: Context): String? =
        context.pairingDataStore.data.map { it[KEY_DEVICE_LABEL] }.first()

    suspend fun saveDeviceLabel(context: Context, label: String) {
        context.pairingDataStore.edit { prefs -> prefs[KEY_DEVICE_LABEL] = label }
    }

    suspend fun clear(context: Context) {
        context.pairingDataStore.edit { prefs ->
            prefs.remove(KEY_HOST); prefs.remove(KEY_PORT); prefs.remove(KEY_TOKEN)
        }
    }

    /** Whatever text was last typed into the pairing screen's manual field —
     * saved on every attempt, success or failure, so a flaky connection (or
     * just re-pairing later) doesn't mean retyping the phrase from scratch. */
    suspend fun getLastManualInput(context: Context): String? =
        context.pairingDataStore.data.map { it[KEY_LAST_MANUAL_INPUT] }.first()

    suspend fun saveLastManualInput(context: Context, text: String) {
        context.pairingDataStore.edit { prefs -> prefs[KEY_LAST_MANUAL_INPUT] = text }
    }
}
