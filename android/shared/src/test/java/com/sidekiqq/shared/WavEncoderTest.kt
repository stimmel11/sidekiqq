package com.sidekiqq.shared

import com.sidekiqq.shared.audio.PcmBuffer
import com.sidekiqq.shared.audio.WavEncoder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class WavEncoderTest {

    private fun le(bytes: ByteArray) = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    private fun ascii(bytes: ByteArray, from: Int) = String(bytes, from, 4, Charsets.US_ASCII)

    @Test
    fun headerIsCanonical16kMono16bit() {
        val pcm = ByteArray(3200) { (it % 256).toByte() } // 100 ms
        val wav = WavEncoder.encode(pcm)
        val b = le(wav)

        assertEquals(44 + 3200, wav.size)
        assertEquals("RIFF", ascii(wav, 0))
        assertEquals(36 + 3200, b.getInt(4))
        assertEquals("WAVE", ascii(wav, 8))
        assertEquals("fmt ", ascii(wav, 12))
        assertEquals(16, b.getInt(16))
        assertEquals(1, b.getShort(20).toInt())      // PCM
        assertEquals(1, b.getShort(22).toInt())      // mono
        assertEquals(16_000, b.getInt(24))           // sample rate
        assertEquals(32_000, b.getInt(28))           // byte rate
        assertEquals(2, b.getShort(32).toInt())      // block align
        assertEquals(16, b.getShort(34).toInt())     // bits/sample
        assertEquals("data", ascii(wav, 36))
        assertEquals(3200, b.getInt(40))
        assertArrayEquals(pcm, wav.copyOfRange(44, wav.size))
    }

    @Test
    fun oddTrailingByteIsDropped() {
        val wav = WavEncoder.encode(ByteArray(5))
        assertEquals(44 + 4, wav.size)
        assertEquals(4, le(wav).getInt(40))
    }

    @Test
    fun emptyPcmProducesHeaderOnly() {
        val wav = WavEncoder.encode(ByteArray(0))
        assertEquals(44, wav.size)
        assertEquals(36, le(wav).getInt(4))
        assertEquals(0, le(wav).getInt(40))
    }

    @Test
    fun shortArrayIsLittleEndian() {
        val wav = WavEncoder.encode(shortArrayOf(0x0102, -2))
        assertArrayEquals(byteArrayOf(0x02, 0x01, 0xFE.toByte(), 0xFF.toByte()), wav.copyOfRange(44, 48))
    }

    @Test
    fun durationMath() {
        assertEquals(1000L, WavEncoder.durationMs(32_000))
        assertEquals(250L, WavEncoder.durationMs(8_000))
    }

    @Test
    fun pcmBufferSilencePadding() {
        val buf = PcmBuffer()
        buf.append(byteArrayOf(1, 2))
        buf.appendSilence(4)
        buf.append(byteArrayOf(3, 4))
        assertArrayEquals(byteArrayOf(1, 2, 0, 0, 0, 0, 3, 4), buf.toByteArray())
    }
}
