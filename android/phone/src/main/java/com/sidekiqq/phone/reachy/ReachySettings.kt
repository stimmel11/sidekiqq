package com.sidekiqq.phone.reachy

import android.content.Context
import android.content.SharedPreferences

/** Where the phone finds the Reachy daemon on the home LAN. Not secret, so plain prefs. */
class ReachySettings(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("sidekiqq_reachy", Context.MODE_PRIVATE)

    /** The saved host, or the default `reachy-mini.local:8000`. A bad saved value falls back too. */
    val host: ReachyHost
        get() = prefs.getString(KEY_HOST, null)?.let { ReachyLan.parseHost(it) } ?: DEFAULT

    /** Saves [raw] if it parses ([ReachyLan.parseHost]) and returns it; null leaves the old value. */
    fun save(raw: String): ReachyHost? {
        val h = ReachyLan.parseHost(raw) ?: return null
        prefs.edit().putString(KEY_HOST, h.display).apply()
        return h
    }

    private companion object {
        const val KEY_HOST = "host"
        val DEFAULT: ReachyHost = ReachyLan.parseHost(ReachyLan.DEFAULT_HOST)!!
    }
}
