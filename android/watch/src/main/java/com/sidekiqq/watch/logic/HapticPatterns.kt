package com.sidekiqq.watch.logic

import com.sidekiqq.shared.model.Importance

/**
 * Haptic waveform for one importance level, in the format VibrationEffect.createWaveform() and
 * NotificationChannel.setVibrationPattern() take: timings alternate off/on starting with "off".
 * amplitudes[i] applies to timings[i] (0 = off, 1..255 = strength).
 */
class HapticPattern(val timings: LongArray, val amplitudes: IntArray) {
    init {
        require(timings.size == amplitudes.size) { "timings and amplitudes must be the same length" }
    }

    val isSilent: Boolean get() = timings.isEmpty()

    /** Sum of the "on" segments, in ms. */
    val totalOnMs: Long get() = timings.filterIndexed { i, _ -> amplitudes[i] > 0 }.sum()

    /** Number of distinct buzzes the wearer feels. */
    val pulseCount: Int get() = amplitudes.count { it > 0 }

    override fun equals(other: Any?): Boolean =
        other is HapticPattern && timings.contentEquals(other.timings) && amplitudes.contentEquals(other.amplitudes)

    override fun hashCode(): Int = 31 * timings.contentHashCode() + amplitudes.contentHashCode()

    override fun toString(): String = "HapticPattern(${timings.toList()}, ${amplitudes.toList()})"
}

/**
 * Picks a haptic pattern per importance. CRITICAL must be unmistakable without looking at the
 * watch: three long, full-strength pulses. Everything below it gets progressively quieter, and
 * FYI is silent.
 */
object HapticPatterns {
    val CRITICAL = HapticPattern(
        timings = longArrayOf(0, 400, 150, 400, 150, 800),
        amplitudes = intArrayOf(0, 255, 0, 255, 0, 255),
    )
    val HIGH = HapticPattern(
        timings = longArrayOf(0, 250, 120, 250),
        amplitudes = intArrayOf(0, 200, 0, 200),
    )
    val MEDIUM = HapticPattern(
        timings = longArrayOf(0, 200),
        amplitudes = intArrayOf(0, 160),
    )
    val LOW = HapticPattern(
        timings = longArrayOf(0, 80),
        amplitudes = intArrayOf(0, 100),
    )
    val SILENT = HapticPattern(LongArray(0), IntArray(0))

    /** Short tick when the medallion reply lands while the app is open. */
    val REPLY = HapticPattern(longArrayOf(0, 60, 80, 60), intArrayOf(0, 180, 0, 180))

    fun forImportance(importance: Importance): HapticPattern = when (importance) {
        Importance.CRITICAL -> CRITICAL
        Importance.HIGH -> HIGH
        Importance.MEDIUM -> MEDIUM
        Importance.LOW -> LOW
        Importance.FYI -> SILENT
    }
}
