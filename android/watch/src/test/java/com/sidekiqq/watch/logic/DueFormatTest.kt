package com.sidekiqq.watch.logic

import com.sidekiqq.shared.model.CommitmentStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class DueFormatTest {
    private val denver = ZoneId.of("America/Denver")
    // 2026-10-16 10:00 MDT
    private val now = Instant.parse("2026-10-16T16:00:00Z")

    @Test fun parsesInstantOffsetAndBareDate() {
        assertEquals(Instant.parse("2026-10-16T17:00:00Z"), DueFormat.parse("2026-10-16T17:00:00Z", denver))
        assertEquals(Instant.parse("2026-10-16T17:00:00Z"), DueFormat.parse("2026-10-16T11:00:00-06:00", denver))
        // A bare date means the end of that local day.
        assertEquals(Instant.parse("2026-10-17T05:59:59Z"), DueFormat.parse("2026-10-16", denver))
    }

    @Test fun parseRejectsGarbage() {
        assertNull(DueFormat.parse(null, denver))
        assertNull(DueFormat.parse("", denver))
        assertNull(DueFormat.parse("next friday", denver))
    }

    @Test fun overdueLabels() {
        assertEquals("Overdue 3d", DueFormat.label(now.minusSeconds(3 * 86_400 + 60), false, now, denver))
        assertEquals("Overdue 5h", DueFormat.label(now.minusSeconds(5 * 3_600 + 10), false, now, denver))
        assertEquals("Overdue", DueFormat.label(now.minusSeconds(120), false, now, denver))
    }

    @Test fun upcomingLabels() {
        assertEquals("Due in 40m", DueFormat.label(now.plusSeconds(40 * 60), false, now, denver))
        assertEquals("Due today", DueFormat.label(Instant.parse("2026-10-16T23:00:00Z"), false, now, denver))
        assertEquals("Due tomorrow", DueFormat.label(Instant.parse("2026-10-17T18:00:00Z"), false, now, denver))
        assertEquals("Due in 4d", DueFormat.label(Instant.parse("2026-10-20T18:00:00Z"), false, now, denver))
        assertEquals("Due Oct 30", DueFormat.label(Instant.parse("2026-10-30T18:00:00Z"), false, now, denver))
    }

    @Test fun inferredDatesAreAlwaysMarked() {
        val overdue = DueFormat.label(now.minusSeconds(2 * 86_400 + 1), inferred = true, now = now, zone = denver)
        assertEquals("Overdue 2d · inferred", overdue)
        val upcoming = DueFormat.label(Instant.parse("2026-10-17T18:00:00Z"), true, now, denver)
        assertTrue(upcoming.endsWith(DueFormat.INFERRED_SUFFIX))
        assertTrue(upcoming.contains("inferred"))
    }

    @Test fun noDueDate() {
        assertEquals("No due date", DueFormat.label(null, false, now, denver))
        // There's nothing to infer without a date, so no suffix.
        assertEquals("No due date", DueFormat.label(null, true, now, denver))
        // The server says overdue but sent no date.
        assertEquals("Overdue", DueFormat.label(null, false, now, denver, overdue = true))
    }

    @Test fun serverStatusWinsForOverdue() {
        val future = now.plusSeconds(86_400)
        val past = now.minusSeconds(60)
        assertTrue(DueFormat.isOverdue(CommitmentStatus.OVERDUE, future, now))
        assertTrue(DueFormat.isOverdue(CommitmentStatus.OVERDUE, null, now))
        assertTrue(DueFormat.isOverdue(CommitmentStatus.OPEN, past, now))
        assertFalse(DueFormat.isOverdue(CommitmentStatus.OPEN, future, now))
        assertFalse(DueFormat.isOverdue(CommitmentStatus.OPEN, null, now))
    }
}
