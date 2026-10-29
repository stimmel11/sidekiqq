package com.sidekiqq.phone.handoff

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandNudgeTest {

    private val nudge = mapOf("kind" to "command", "commandId" to "cmd_ab12-CD")

    @Test
    fun alertsAreNotNudges() {
        val alert = mapOf("kind" to "email", "title" to "Dana", "body" to "Waiting on proposal")
        assertFalse(CommandNudge.isNudge(alert))
        assertEquals(NudgeAction.NotANudge, CommandNudge.decide(alert, paired = true, appVisible = true))
        assertEquals(NudgeAction.NotANudge, CommandNudge.decide(emptyMap(), paired = true, appVisible = false))
    }

    @Test
    fun visibleAppPollsAndBackgroundNotifies() {
        assertTrue(CommandNudge.isNudge(nudge))
        assertEquals(NudgeAction.PollNow, CommandNudge.decide(nudge, paired = true, appVisible = true))
        assertEquals(NudgeAction.NotifyWaiting, CommandNudge.decide(nudge, paired = true, appVisible = false))
    }

    @Test
    fun unpairedOrMalformedNudgesAreDroppedNotShownAsAlerts() {
        assertEquals(NudgeAction.Ignore, CommandNudge.decide(nudge, paired = false, appVisible = true))
        assertEquals(NudgeAction.Ignore, CommandNudge.decide(mapOf("kind" to "command"), paired = true, appVisible = false))
        assertEquals(
            NudgeAction.Ignore,
            CommandNudge.decide(mapOf("kind" to "command", "commandId" to "x y"), paired = true, appVisible = false),
        )
        assertEquals(
            NudgeAction.Ignore,
            CommandNudge.decide(mapOf("kind" to "command", "commandId" to "a".repeat(65)), paired = true, appVisible = true),
        )
        // Even with a title/body smuggled in, a nudge never becomes an alert.
        val withText = nudge + mapOf("title" to "Call bank", "body" to "+1 800 555 0100")
        assertEquals(NudgeAction.NotifyWaiting, CommandNudge.decide(withText, paired = true, appVisible = false))
    }
}
