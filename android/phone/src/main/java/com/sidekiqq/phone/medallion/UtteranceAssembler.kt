package com.sidekiqq.phone.medallion

import com.sidekiqq.shared.audio.PcmBuffer
import com.sidekiqq.shared.audio.WavEncoder

/**
 * Reassembles one medallion utterance from AUDIO notifications delimited by CONTROL 0x01 / 0x02.
 *
 * Sequence handling: each AUDIO payload starts with a uint8 counter that wraps 255 -> 0.
 *  - in order: append
 *  - duplicate (counter equal to the previous one): dropped
 *  - forward gap of 1..[maxPaddedGap] packets: pad with silence the size of the missing packets
 *    (assuming the last packet's length) so timing stays intact, and count the gap
 *  - larger gap or a backwards jump (late/reordered packet): dropped and flagged
 * The first packet after START sets the baseline whatever its counter is.
 *
 * Pure Kotlin (no Android APIs) so it is unit-tested on the JVM.
 */
class UtteranceAssembler(
    private val maxPaddedGap: Int = 8,
    private val maxBytes: Int = WavEncoder.SAMPLE_RATE * 2 * 30, // 30 s cap
) {
    data class Stats(
        val packets: Int,
        val gaps: Int,
        val missingPackets: Int,
        val duplicates: Int,
        val outOfOrder: Int,
        val truncated: Boolean,
    ) {
        val degraded: Boolean get() = gaps > 0 || outOfOrder > 0 || truncated
    }

    data class Utterance(val pcm: ByteArray, val stats: Stats) {
        val durationMs: Long get() = WavEncoder.durationMs(pcm.size)
        override fun equals(other: Any?) = other is Utterance && pcm.contentEquals(other.pcm) && stats == other.stats
        override fun hashCode() = 31 * pcm.contentHashCode() + stats.hashCode()
    }

    private val buf = PcmBuffer()
    private var lastSeq = -1
    private var lastLen = 0
    private var packets = 0
    private var gaps = 0
    private var missing = 0
    private var dups = 0
    private var ooo = 0
    private var truncated = false

    var isActive: Boolean = false
        private set

    fun start() {
        reset()
        isActive = true
    }

    fun cancel() {
        reset()
        isActive = false
    }

    /** Feed one raw AUDIO notification (including the seq byte). Ignored when not active. */
    fun onAudio(packet: ByteArray) {
        if (!isActive || packet.size < 2) return
        val seq = packet[0].toInt() and 0xFF
        val payloadLen = packet.size - 1

        if (lastSeq >= 0) {
            val delta = (seq - lastSeq + 256) % 256
            when {
                delta == 0 -> { dups++; return }
                delta == 1 -> Unit
                delta in 2..(maxPaddedGap + 1) -> {
                    val lost = delta - 1
                    gaps++
                    missing += lost
                    appendBounded(null, lost * (if (lastLen > 0) lastLen else payloadLen))
                }
                // A large forward jump is indistinguishable from a late packet; treat >128 as backwards.
                delta > 128 -> { ooo++; return }
                else -> {
                    // Too big to pad sensibly: keep going from here but flag it.
                    gaps++
                    missing += delta - 1
                }
            }
        }
        lastSeq = seq
        lastLen = payloadLen
        packets++
        appendBounded(packet, payloadLen, offset = 1)
    }

    /** Ends the utterance and returns it (also valid if [start] was missed but audio is present). */
    fun finish(): Utterance? {
        if (!isActive) return null
        isActive = false
        val pcm = buf.toByteArray()
        val result = Utterance(pcm, Stats(packets, gaps, missing, dups, ooo, truncated))
        reset()
        return result
    }

    private fun appendBounded(src: ByteArray?, len: Int, offset: Int = 0) {
        val room = maxBytes - buf.size
        if (room <= 0) { truncated = true; return }
        val n = minOf(len, room)
        if (n < len) truncated = true
        if (src == null) buf.appendSilence(n) else buf.append(src, offset, n)
    }

    private fun reset() {
        buf.reset()
        lastSeq = -1
        lastLen = 0
        packets = 0; gaps = 0; missing = 0; dups = 0; ooo = 0
        truncated = false
    }
}
