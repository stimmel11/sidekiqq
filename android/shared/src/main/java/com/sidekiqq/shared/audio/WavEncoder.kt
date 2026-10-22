package com.sidekiqq.shared.audio

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Wraps raw little-endian PCM16 samples in a canonical 44-byte RIFF/WAVE header.
 * Default format matches the brain's /api/transcribe contract: 16 kHz, mono, 16-bit.
 */
object WavEncoder {
    const val SAMPLE_RATE = 16_000
    const val CHANNELS = 1
    const val BITS_PER_SAMPLE = 16
    const val HEADER_SIZE = 44

    /** Encode PCM16 LE bytes. An odd trailing byte (half sample) is dropped. */
    fun encode(
        pcm: ByteArray,
        sampleRate: Int = SAMPLE_RATE,
        channels: Int = CHANNELS,
    ): ByteArray {
        require(sampleRate > 0) { "sampleRate must be > 0" }
        require(channels in 1..2) { "channels must be 1 or 2" }
        val blockAlign = channels * BITS_PER_SAMPLE / 8
        val dataLen = pcm.size - (pcm.size % blockAlign)
        val byteRate = sampleRate * blockAlign

        val buf = ByteBuffer.allocate(HEADER_SIZE + dataLen).order(ByteOrder.LITTLE_ENDIAN)
        buf.put("RIFF".toByteArray(Charsets.US_ASCII))
        buf.putInt(36 + dataLen)
        buf.put("WAVE".toByteArray(Charsets.US_ASCII))
        buf.put("fmt ".toByteArray(Charsets.US_ASCII))
        buf.putInt(16) // PCM fmt chunk size
        buf.putShort(1) // audio format = PCM
        buf.putShort(channels.toShort())
        buf.putInt(sampleRate)
        buf.putInt(byteRate)
        buf.putShort(blockAlign.toShort())
        buf.putShort(BITS_PER_SAMPLE.toShort())
        buf.put("data".toByteArray(Charsets.US_ASCII))
        buf.putInt(dataLen)
        buf.put(pcm, 0, dataLen)
        return buf.array()
    }

    /** Encode ShortArray samples (e.g. from AudioRecord.read(ShortArray...)). */
    fun encode(samples: ShortArray, sampleRate: Int = SAMPLE_RATE, channels: Int = CHANNELS): ByteArray {
        val bytes = ByteBuffer.allocate(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        bytes.asShortBuffer().put(samples)
        return encode(bytes.array(), sampleRate, channels)
    }

    /** Duration in milliseconds of [pcmBytes] PCM16 bytes at the given format. */
    fun durationMs(pcmBytes: Int, sampleRate: Int = SAMPLE_RATE, channels: Int = CHANNELS): Long =
        pcmBytes.toLong() * 1000L / (sampleRate.toLong() * channels * (BITS_PER_SAMPLE / 8))
}

/** Growable PCM buffer used while capturing an utterance. Not thread-safe. */
class PcmBuffer(initialCapacity: Int = 16_000 * 2 * 5) {
    private val out = ByteArrayOutputStream(initialCapacity)
    val size: Int get() = out.size()
    fun append(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size - offset) = out.write(bytes, offset, length)
    fun appendSilence(byteCount: Int) { if (byteCount > 0) out.write(ByteArray(byteCount)) }
    fun toByteArray(): ByteArray = out.toByteArray()
    fun reset() = out.reset()
}
