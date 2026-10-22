package com.sidekiqq.watch.logic

/**
 * The Ask button supports two gestures:
 *  - press and hold: record while held, send on release
 *  - quick tap: start recording and keep going (hands free), then tap again to send
 */
object PushToTalk {
    /** A press shorter than this counts as a tap, which latches recording on. */
    const val TAP_THRESHOLD_MS = 350L

    /** Recording cap. A minute of 16 kHz mono PCM16 is about 1.9 MB of WAV. */
    const val MAX_RECORDING_MS = 60_000L

    /** Clips shorter than this are thrown away as accidental. */
    const val MIN_RECORDING_MS = 400L

    const val SAMPLE_RATE = 16_000

    enum class Release { SEND, LATCH }

    fun onRelease(heldMs: Long): Release = if (heldMs < TAP_THRESHOLD_MS) Release.LATCH else Release.SEND

    /** PCM16 mono: 2 bytes per sample. */
    fun pcmDurationMs(pcmBytes: Int, sampleRate: Int = SAMPLE_RATE): Long =
        pcmBytes.toLong() * 1000L / (sampleRate * 2L)

    fun isTooShort(pcmBytes: Int): Boolean = pcmDurationMs(pcmBytes) < MIN_RECORDING_MS

    fun maxPcmBytes(sampleRate: Int = SAMPLE_RATE): Int = (sampleRate * 2L * MAX_RECORDING_MS / 1000L).toInt()
}
