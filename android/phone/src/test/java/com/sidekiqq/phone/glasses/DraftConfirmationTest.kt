package com.sidekiqq.phone.glasses

import com.sidekiqq.phone.assistant.DraftConfirmation
import com.sidekiqq.phone.assistant.DraftConfirmation.Decision
import com.sidekiqq.shared.model.Draft
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DraftConfirmationTest {

    private val d1 = Draft(id = "d1", to = listOf("dana@acme.com"), subject = "Proposal", body = "Attached.", createdAt = "2026-11-06T00:00:00Z")

    @Test
    fun onlyExactSendItConfirms() {
        listOf("send it", "Send it.", "  SEND   IT! ").forEach { assertTrue(it, DraftConfirmation.isSendIt(it)) }
        listOf(
            "don't send it", "do not send it", "send it later", "yes", "sure", "send", "send it to someone else",
            "okay send it", "", "sent it",
        ).forEach { assertFalse(it, DraftConfirmation.isSendIt(it)) }
    }

    @Test
    fun confirmsWithinWindow() {
        var t = 1_000L
        val c = DraftConfirmation(windowMs = 30_000, now = { t })
        assertTrue(DraftConfirmation.prompt(d1).endsWith("Say 'send it' to confirm, or anything else to cancel."))
        c.arm(d1)
        assertEquals("d1", c.pending?.draftId)
        t += 5_000
        assertEquals(Decision.Confirmed("d1", DraftConfirmation.fingerprint(d1)), c.evaluate("send it", spokenAt = t - 1_000))
        assertNull(c.pending)
    }

    @Test
    fun anythingElseDeclinesAndConsumes() {
        val c = DraftConfirmation()
        c.arm(d1)
        assertEquals(Decision.Declined, c.evaluate("what's on my calendar", spokenAt = Long.MAX_VALUE))
        // A later "send it" must not resurrect the declined draft.
        assertEquals(Decision.NothingPending, c.evaluate("send it", spokenAt = Long.MAX_VALUE))
    }

    @Test
    fun expiresAfterWindow() {
        var t = 0L
        val c = DraftConfirmation(windowMs = 30_000, now = { t })
        c.arm(d1)
        t = 31_000
        assertEquals(Decision.Expired, c.evaluate("send it", spokenAt = 30_500))
    }

    @Test
    fun nothingPending() {
        assertEquals(Decision.NothingPending, DraftConfirmation().evaluate("send it", spokenAt = 0))
    }

    @Test
    fun speechThatStartedBeforeTheWindowDeclines() {
        var t = 10_000L
        val c = DraftConfirmation(now = { t })
        c.arm(d1)
        t += 2_000
        // Started during the read-back (before arm): declines and consumes.
        assertEquals(Decision.Declined, c.evaluate("send it", spokenAt = 9_000))
        assertEquals(Decision.NothingPending, c.evaluate("send it", spokenAt = 11_000))
    }

    @Test
    fun unknownStartTimeNeverConfirms() {
        val c = DraftConfirmation()
        c.arm(d1)
        assertEquals(Decision.Declined, c.evaluate("send it", spokenAt = null))
    }

    @Test
    fun speechStartingExactlyAtArmConfirms() {
        val c = DraftConfirmation(now = { 5_000L })
        c.arm(d1)
        assertEquals(Decision.Confirmed("d1", DraftConfirmation.fingerprint(d1)), c.evaluate("send it", spokenAt = 5_000))
    }
}
