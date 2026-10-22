package com.sidekiqq.watch.logic

import com.sidekiqq.shared.model.Importance
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HapticPatternsTest {

    @Test fun criticalIsDistinctFromEveryOtherLevel() {
        val critical = HapticPatterns.forImportance(Importance.CRITICAL)
        Importance.entries.filter { it != Importance.CRITICAL }.forEach {
            assertNotEquals("CRITICAL must differ from $it", critical, HapticPatterns.forImportance(it))
        }
    }

    @Test fun criticalHasMostPulsesAndLongestBuzz() {
        val critical = HapticPatterns.CRITICAL
        listOf(HapticPatterns.HIGH, HapticPatterns.MEDIUM, HapticPatterns.LOW).forEach {
            assertTrue(critical.pulseCount > it.pulseCount)
            assertTrue(critical.totalOnMs > it.totalOnMs)
        }
        assertEquals(3, critical.pulseCount)
        assertTrue(critical.amplitudes.all { it == 0 || it == 255 })
    }

    @Test fun strengthDecreasesWithImportance() {
        val order = listOf(Importance.CRITICAL, Importance.HIGH, Importance.MEDIUM, Importance.LOW, Importance.FYI)
        val onMs = order.map { HapticPatterns.forImportance(it).totalOnMs }
        assertEquals(onMs.sortedDescending(), onMs)
    }

    @Test fun fyiIsSilent() {
        assertTrue(HapticPatterns.forImportance(Importance.FYI).isSilent)
    }

    @Test fun waveformsStartWithOffSegmentAndHaveMatchingLengths() {
        Importance.entries.map(HapticPatterns::forImportance).filterNot { it.isSilent }.forEach {
            assertEquals(it.timings.size, it.amplitudes.size)
            assertEquals(0, it.amplitudes[0])
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun mismatchedArraysRejected() {
        HapticPattern(longArrayOf(0, 100), intArrayOf(0))
    }
}
