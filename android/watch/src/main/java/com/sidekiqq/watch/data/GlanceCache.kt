package com.sidekiqq.watch.data

import android.content.Context
import com.sidekiqq.shared.SideKiqqJson
import com.sidekiqq.shared.model.Importance
import kotlinx.serialization.Serializable

/**
 * Last-known-good summary for the tile and complication, so they still render offline, with the
 * phone out of range, or before the first fetch finishes. Stored as one small JSON string.
 */
@Serializable
data class GlanceSnapshot(
    val top: List<GlanceItem>,
    val overdueCount: Int,
    val followUpCount: Int,
    val fetchedAtMs: Long,
) {
    @Serializable
    data class GlanceItem(val title: String, val importance: Importance)

    fun toJson(): String = SideKiqqJson.encodeToString(serializer(), this)

    companion object {
        val EMPTY = GlanceSnapshot(emptyList(), -1, -1, 0L)

        fun fromJson(json: String?): GlanceSnapshot {
            if (json.isNullOrBlank()) return EMPTY
            return runCatching { SideKiqqJson.decodeFromString(serializer(), json) }.getOrDefault(EMPTY)
        }
    }
}

class GlanceCache(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("sidekiqq_glance", Context.MODE_PRIVATE)

    fun read(): GlanceSnapshot = GlanceSnapshot.fromJson(prefs.getString(KEY, null))

    fun write(s: GlanceSnapshot) = prefs.edit().putString(KEY, s.toJson()).apply()

    /** Keeps the rest of the snapshot when only one value changed (e.g. a follow-up approved). */
    @Synchronized
    fun update(transform: (GlanceSnapshot) -> GlanceSnapshot) = write(transform(read()))

    private companion object {
        const val KEY = "snapshot"
    }
}
