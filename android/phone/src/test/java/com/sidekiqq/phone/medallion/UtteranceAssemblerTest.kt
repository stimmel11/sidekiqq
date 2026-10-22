package com.sidekiqq.phone.medallion

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UtteranceAssemblerTest {

    private fun pkt(seq: Int, vararg pcm: Int) = byteArrayOf(seq.toByte(), *pcm.map { it.toByte() }.toByteArray())

    @Test
    fun inOrderPacketsConcatenateWithoutSeqByte() {
        val a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(7, 1, 2))
        a.onAudio(pkt(8, 3, 4))
        val u = a.finish()!!
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), u.pcm)
        assertEquals(2, u.stats.packets)
        assertFalse(u.stats.degraded)
        assertFalse(a.isActive)
    }

    @Test
    fun sequenceWrapsAt255() {
        val a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(254, 1, 1))
        a.onAudio(pkt(255, 2, 2))
        a.onAudio(pkt(0, 3, 3))
        a.onAudio(pkt(1, 4, 4))
        val u = a.finish()!!
        assertEquals(8, u.pcm.size)
        assertEquals(0, u.stats.gaps)
    }

    @Test
    fun smallGapIsPaddedWithSilenceAndFlagged() {
        val a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(10, 1, 2))
        a.onAudio(pkt(13, 5, 6)) // 11 and 12 lost
        val u = a.finish()!!
        assertArrayEquals(byteArrayOf(1, 2, 0, 0, 0, 0, 5, 6), u.pcm)
        assertEquals(1, u.stats.gaps)
        assertEquals(2, u.stats.missingPackets)
        assertTrue(u.stats.degraded)
    }

    @Test
    fun gapAcrossWrapIsPadded() {
        val a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(255, 1, 1))
        a.onAudio(pkt(1, 2, 2)) // 0 lost
        val u = a.finish()!!
        assertArrayEquals(byteArrayOf(1, 1, 0, 0, 2, 2), u.pcm)
        assertEquals(1, u.stats.missingPackets)
    }

    @Test
    fun duplicatesDropped() {
        val a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(3, 1, 1))
        a.onAudio(pkt(3, 1, 1))
        a.onAudio(pkt(4, 2, 2))
        val u = a.finish()!!
        assertArrayEquals(byteArrayOf(1, 1, 2, 2), u.pcm)
        assertEquals(1, u.stats.duplicates)
        assertFalse(u.stats.degraded)
    }

    @Test
    fun latePacketDroppedAndFlagged() {
        val a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(20, 1, 1))
        a.onAudio(pkt(21, 2, 2))
        a.onAudio(pkt(19, 9, 9)) // arrived late
        a.onAudio(pkt(22, 3, 3))
        val u = a.finish()!!
        assertArrayEquals(byteArrayOf(1, 1, 2, 2, 3, 3), u.pcm)
        assertEquals(1, u.stats.outOfOrder)
        assertTrue(u.stats.degraded)
    }

    @Test
    fun largeGapNotPaddedButFlagged() {
        val a = UtteranceAssembler(maxPaddedGap = 2)
        a.start()
        a.onAudio(pkt(0, 1, 1))
        a.onAudio(pkt(50, 2, 2))
        val u = a.finish()!!
        assertArrayEquals(byteArrayOf(1, 1, 2, 2), u.pcm)
        assertEquals(1, u.stats.gaps)
        assertEquals(49, u.stats.missingPackets)
    }

    @Test
    fun cancelDiscardsAndInactiveIgnoresAudio() {
        val a = UtteranceAssembler()
        a.onAudio(pkt(0, 1, 1)) // not started: ignored
        assertNull(a.finish())
        a.start()
        a.onAudio(pkt(0, 1, 1))
        a.cancel()
        assertNull(a.finish())
    }

    @Test
    fun restartResetsSequenceBaseline() {
        val a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(100, 1, 1))
        a.finish()
        a.start()
        a.onAudio(pkt(5, 2, 2)) // new baseline: not a gap
        val u = a.finish()!!
        assertEquals(0, u.stats.gaps)
        assertEquals(0, u.stats.outOfOrder)
    }

    @Test
    fun capTruncates() {
        val a = UtteranceAssembler(maxBytes = 3)
        a.start()
        a.onAudio(pkt(0, 1, 2))
        a.onAudio(pkt(1, 3, 4))
        val u = a.finish()!!
        assertArrayEquals(byteArrayOf(1, 2, 3), u.pcm)
        assertTrue(u.stats.truncated)
    }
}
