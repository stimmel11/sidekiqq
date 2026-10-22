package com.sidekiqq.phone.glasses

import com.sidekiqq.phone.assistant.DraftConfirmation
import com.sidekiqq.phone.assistant.DraftConfirmation.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DraftConfirmationTest {

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
        val prompt = c.offer("d1", "Reply to Dana: proposal attached")
        assertTrue(prompt.contains("Say 'send it' to confirm"))
        t += 5_000
        assertEquals(Decision.Confirmed("d1"), c.evaluate("send it"))
        assertNull(c.pending)
    }

    @Test
    fun anythingElseDeclinesAndConsumes() {
        val c = DraftConfirmation()
        c.offer("d1", "x")
        assertEquals(Decision.Declined, c.evaluate("what's on my calendar"))
        // A later "send it" must not resurrect the declined draft.
        assertEquals(Decision.NothingPending, c.evaluate("send it"))
    }

    @Test
    fun expiresAfterWindow() {
        var t = 0L
        val c = DraftConfirmation(windowMs = 30_000, now = { t })
        c.offer("d1", "x")
        t = 31_000
        assertEquals(Decision.Expired, c.evaluate("send it"))
    }

    @Test
    fun nothingPending() {
        assertEquals(Decision.NothingPending, DraftConfirmation().evaluate("send it"))
    }
}
