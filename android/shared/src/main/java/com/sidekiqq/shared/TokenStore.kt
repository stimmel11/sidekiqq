package com.sidekiqq.shared

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Persists the server URL and device token.
 *
 * The token is encrypted with an AES-256-GCM key held in the Android Keystore (non-exportable)
 * and the ciphertext is stored in SharedPreferences. This is what EncryptedSharedPreferences did
 * internally; androidx.security:security-crypto is deprecated, so we do it directly with platform
 * APIs and avoid the extra dependency.
 *
 * Reads are cached in memory so [token] is cheap enough to use as SideKiqqClient's tokenProvider.
 */
class TokenStore(context: Context, prefsName: String = "sidekiqq_auth") {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(prefsName, Context.MODE_PRIVATE)

    @Volatile private var cachedToken: String? = null
    @Volatile private var tokenLoaded = false

    var baseUrl: String?
        get() = prefs.getString(KEY_BASE_URL, null)
        set(value) { prefs.edit().putString(KEY_BASE_URL, value?.trim()?.trimEnd('/')).apply() }

    /** Synchronous, memory-cached token lookup. Safe to pass as `tokenProvider = store::token`. */
    fun token(): String? {
        if (!tokenLoaded) {
            synchronized(this) {
                if (!tokenLoaded) {
                    cachedToken = prefs.getString(KEY_TOKEN, null)?.let { decryptOrNull(it) }
                    tokenLoaded = true
                }
            }
        }
        return cachedToken
    }

    fun saveToken(token: String) {
        synchronized(this) {
            prefs.edit().putString(KEY_TOKEN, encrypt(token)).apply()
            cachedToken = token
            tokenLoaded = true
        }
    }

    val isPaired: Boolean get() = !baseUrl.isNullOrBlank() && token() != null

    fun clear() {
        synchronized(this) {
            prefs.edit().clear().apply()
            cachedToken = null
            tokenLoaded = true
        }
    }

    // ------------------------------------------------------------ crypto

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(byteArrayOf(iv.size.toByte()) + iv + ct, Base64.NO_WRAP)
    }

    private fun decryptOrNull(stored: String): String? = try {
        val all = Base64.decode(stored, Base64.NO_WRAP)
        val ivLen = all[0].toInt()
        val iv = all.copyOfRange(1, 1 + ivLen)
        val ct = all.copyOfRange(1 + ivLen, all.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        String(cipher.doFinal(ct), Charsets.UTF_8)
    } catch (e: Exception) {
        // Key was invalidated (e.g. backup restored to a new device): force re-pairing.
        null
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "sidekiqq_token_key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_BASE_URL = "base_url"
        const val KEY_TOKEN = "device_token"
    }
}
