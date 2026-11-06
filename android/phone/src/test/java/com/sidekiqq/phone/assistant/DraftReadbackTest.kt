package com.sidekiqq.phone.assistant

import com.sidekiqq.shared.model.Action
import com.sidekiqq.shared.model.ActionType
import com.sidekiqq.shared.model.Draft
import com.sidekiqq.shared.model.DraftKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Read-back parity with apple/SideKiqqKit DraftConfirmationTests.swift and reachy/tests/test_confirm.py. */
class DraftReadbackTest {

    private val dana = Draft(
        id = "dr_1",
        to = listOf("Dana Smith <dana@acme.com>"),
        subject = "Revised proposal",
        body = "Hi Dana,\n\nThe revised proposal is attached with the updated pricing. Let me know if Friday still works.\n\nChris",
        client = "Acme",
        createdAt = "2026-10-22T13:05:00.000Z",
    )

    private val withReadback = dana.copy(readback = "Email to dana@acme.com, with the subject: Revised proposal.")

    @Test
    fun fieldsReadbackWhenTheBrainSendsNone() {
        assertEquals(
            "Email to Dana Smith. Subject: Revised proposal. It says: The revised proposal is attached with the updated pricing.",
            DraftConfirmation.readback(dana),
        )
        assertEquals(
            "Email to Dana Smith. Subject: Revised proposal. It says: The revised proposal is attached with the updated pricing. " +
                "Say 'send it' to confirm, or anything else to cancel.",
            DraftConfirmation.prompt(dana),
        )
    }

    @Test
    fun prefersTheBrainsReadbackThenMessageBegins() {
        assertEquals(
            "Email to dana@acme.com, with the subject: Revised proposal. Message begins: The revised proposal is attached with the updated pricing.",
            DraftConfirmation.readback(withReadback),
        )
    }

    @Test
    fun severalRecipientsCcAndEmptyParts() {
        val d = Draft(
            id = "x",
            to = listOf("mike@example.com", "\"Sam Lee\" <sam@example.com>", "ann@example.com"),
            cc = listOf("ops@example.com"),
            subject = "  ",
            body = "\n\n",
            createdAt = "2026-10-22T00:00:00Z",
        )
        assertEquals(
            "Email to mike@example.com, Sam Lee and ann@example.com, copying ops@example.com. Subject: no subject. The message is empty.",
            DraftConfirmation.readback(d),
        )
        assertEquals(
            "Email to dana@acme.com, with the subject: Revised proposal. The message is empty.",
            DraftConfirmation.readback(withReadback.copy(body = "Hi Dana,\n")),
        )
    }

    @Test
    fun spokenRecipients() {
        assertEquals("a@b.com", DraftConfirmation.spokenRecipients(listOf("<a@b.com>")))
        assertEquals("no recipient", DraftConfirmation.spokenRecipients(emptyList()))
        assertEquals("A and B", DraftConfirmation.spokenRecipients(listOf("A <a@x>", "B <b@x>")))
    }

    @Test
    fun bodySummaryCapsOnAWordBoundary() {
        val long = "word ".repeat(60).trim() + "."
        val s = DraftConfirmation.bodySummary(long, maxChars = 30)
        assertTrue(s, s.endsWith("…"))
        assertTrue(s, s.length <= 31)
        assertEquals("Version 2.5 is out!", DraftConfirmation.bodySummary("Version 2.5 is out! More later."))
        assertEquals("Thanks.", DraftConfirmation.bodySummary("Good morning,\r\nThanks."))
    }

    // ---- DraftOffer.plan

    private val action = Action(ActionType.DRAFT_CREATED, "dr_1", "Email to dana@acme.com, with the subject: Revised proposal.")

    @Test
    fun planUsesTheFetchedDraftWithBody() {
        val p = DraftOffer.plan(action, listOf(withReadback.copy(id = "other"), withReadback))
        assertEquals(DraftConfirmation.prompt(withReadback), p.speak)
        assertTrue(p.speak.contains("Message begins: The revised proposal"))
        assertEquals(withReadback, p.arm)
    }

    @Test
    fun planArmsNothingWhenTheFetchFailed() {
        val p = DraftOffer.plan(action, null)
        assertEquals(DraftOffer.APPROVE_IN_APP, p.speak)
        assertNull(p.arm)
    }

    @Test
    fun planArmsNothingWhenTheDraftIsNoLongerPending() {
        val p = DraftOffer.plan(action, listOf(withReadback.copy(id = "dr_2")))
        assertEquals(DraftOffer.NOT_WAITING, p.speak)
        assertNull(p.arm)
        assertNull(DraftOffer.plan(action, emptyList()).arm)
    }

    @Test
    fun planArmsNothingForKindsVoiceCantReadBack() {
        listOf(DraftKind.CALENDAR_INVITE, DraftKind.CALENDAR_HOLD, "something_new").forEach { kind ->
            val p = DraftOffer.plan(action, listOf(withReadback.copy(kind = kind)))
            assertEquals(kind, DraftOffer.APPROVE_IN_APP, p.speak)
            assertNull(kind, p.arm)
        }
    }

    // ---- DraftOffer.checkBeforeApprove

    private val confirmed = DraftConfirmation.Decision.Confirmed("dr_1", DraftConfirmation.fingerprint(withReadback))

    @Test
    fun approveGoesAheadOnlyForTheUnchangedPendingDraft() {
        assertNull(DraftOffer.checkBeforeApprove(confirmed, listOf(withReadback)))
        assertEquals(DraftOffer.CANT_CHECK, DraftOffer.checkBeforeApprove(confirmed, null))
        assertEquals(DraftOffer.NOT_WAITING, DraftOffer.checkBeforeApprove(confirmed, emptyList()))
        listOf(
            withReadback.copy(body = withReadback.body + " PS: wire the money."),
            withReadback.copy(to = listOf("mallory@evil.example")),
            withReadback.copy(cc = listOf("x@y.com")),
            withReadback.copy(subject = "Other"),
            withReadback.copy(kind = DraftKind.CALENDAR_INVITE),
        ).forEach { edited ->
            assertEquals(edited.toString(), DraftOffer.CHANGED, DraftOffer.checkBeforeApprove(confirmed, listOf(edited)))
        }
    }

    @Test
    fun fingerprintSeparatesFieldBoundaries() {
        val c = withReadback.copy(subject = "x", body = "y")
        val d = withReadback.copy(subject = "xy", body = "")
        assertTrue(DraftConfirmation.fingerprint(c) != DraftConfirmation.fingerprint(d))
    }
}
