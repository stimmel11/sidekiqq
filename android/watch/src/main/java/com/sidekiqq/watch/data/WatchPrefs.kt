package com.sidekiqq.watch.data

import android.content.Context
import android.content.SharedPreferences
import com.sidekiqq.shared.TokenStore
import com.sidekiqq.watch.BuildConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Watch settings. The device token and brain URL are delegated to :shared [TokenStore], which
 * keeps the token encrypted with a Keystore AES-GCM key. Watch-only preferences (TTS,
 * conversation id) live in a separate file.
 *
 * Every token write must go through this class (one instance, owned by SideKiqqApp), so
 * [tokenState] always reflects the truth.
 */
class WatchPrefs(context: Context) {

    private val store = TokenStore(context.applicationContext)
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    private val _tokenState = MutableStateFlow(store.token())
    val tokenState: StateFlow<String?> = _tokenState.asStateFlow()

    var token: String?
        get() = store.token()?.takeIf { it.isNotBlank() }
        set(value) {
            if (value.isNullOrBlank()) {
                // TokenStore.clear() also clears baseUrl; we then fall back to BuildConfig.
                store.clear()
            } else {
                store.saveToken(value)
            }
            _tokenState.value = token
        }

    /** The phone overrides this through the config DataItem; BuildConfig.BRAIN_URL is the default. */
    var baseUrl: String
        get() = store.baseUrl?.takeIf { it.isNotBlank() } ?: BuildConfig.BRAIN_URL
        set(value) {
            store.baseUrl = value
        }

    /** Read `spoken` aloud after each answer. Off by default; wrist speakers are public. */
    var ttsEnabled: Boolean
        get() = prefs.getBoolean(KEY_TTS, false)
        set(value) = prefs.edit().putBoolean(KEY_TTS, value).apply()

    var conversationId: String?
        get() = prefs.getString(KEY_CONVERSATION, null)
        set(value) = prefs.edit().putString(KEY_CONVERSATION, value).apply()

    /** Pass as SideKiqqClient(tokenProvider = ...). Reads TokenStore's in-memory cache each call. */
    val tokenProvider: () -> String? = { store.token() }

    companion object {
        private const val FILE = "sidekiqq_watch"
        private const val KEY_TTS = "tts_enabled"
        private const val KEY_CONVERSATION = "conversation_id"
    }
}
