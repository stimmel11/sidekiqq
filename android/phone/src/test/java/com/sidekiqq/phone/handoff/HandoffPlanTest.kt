package com.sidekiqq.phone.handoff

import com.sidekiqq.shared.model.DeviceCommand
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandoffPlanTest {

    private fun cmd(
        kind: String,
        id: String = "c1",
        url: String? = null,
        number: String? = null,
        app: String? = null,
    ) = DeviceCommand(
        id = id, at = "2026-10-27T10:00:00Z", expiresAt = "2026-10-27T10:15:00Z", kind = kind,
        label = "label", from = "watch", url = url, number = number, app = app,
    )

    @Test
    fun callDefaultsToDialer() {
        assertEquals(HandoffPlan.Dial("+13035550142"), Handoffs.planFor(cmd("call_contact", number = "+13035550142")))
        assertEquals(HandoffPlan.Dial("911"), Handoffs.planFor(cmd("call_contact", number = "911", app = "phone")))
    }

    @Test
    fun whatsappNeedsPlusAndBuildsWaMe() {
        val p = Handoffs.planFor(cmd("call_contact", number = "+13035550142", app = "whatsapp"))
        assertEquals(HandoffPlan.WhatsApp("+13035550142"), p)
        assertEquals("https://wa.me/13035550142", (p as HandoffPlan.WhatsApp).url)
        assertTrue(Handoffs.planFor(cmd("call_contact", number = "3035550142", app = "whatsapp")) is HandoffPlan.CantOpen)
    }

    @Test
    fun badNumbersNeverDial() {
        listOf(
            null, "", "12", "1234567890123456", "*#06#", "555,1234", "555;1", "tel:5551234", "303 555 0142",
            "+1(303)5550142", "++15551234", "5551234\n", "١٢٣٤٥٦٧",
        ).forEach { n ->
            assertTrue("$n", Handoffs.planFor(cmd("call_contact", number = n)) is HandoffPlan.CantOpen)
        }
        assertTrue(Handoffs.planFor(cmd("call_contact", number = "5551234", app = "signal")) is HandoffPlan.CantOpen)
    }

    @Test
    fun allowlistedHttpsLinksOpen() {
        val p = Handoffs.planFor(cmd("open_url", url = "https://meet.google.com/abc-defg-hij"))
        assertEquals(HandoffPlan.Browser("https://meet.google.com/abc-defg-hij", "meet.google.com"), p)
        listOf(
            "https://zoom.us/j/123", "https://us02web.zoom.us/j/123?pwd=x", "https://www.kroger.com/cart",
            "https://www.kingsoopers.com/cart", "https://MEET.google.com/x",
        ).forEach { assertTrue(it, Handoffs.planFor(cmd("open_url", url = it)) is HandoffPlan.Browser) }
    }

    @Test
    fun otherLinksNeverOpen() {
        listOf(
            null, "", "not a url", "http://meet.google.com/x", "https://evil.com/meet.google.com",
            "https://meet.google.com.evil.com/x", "https://evilzoom.us/j/1", "https://user@meet.google.com/x",
            "https://meet.google.com:8443/x", "javascript:alert(1)", "intent://meet.google.com#Intent;end",
            "https://kroger.com/cart", "file:///sdcard/x", "//meet.google.com/x", "https://meet.google.com@evil.com/",
        ).forEach { assertTrue("$it", Handoffs.planFor(cmd("open_url", url = it)) is HandoffPlan.CantOpen) }
    }

    @Test
    fun unknownKindsCantOpenAndAreNotPhoneKinds() {
        assertTrue(Handoffs.planFor(cmd("reachy_wake")) is HandoffPlan.CantOpen)
        assertTrue(Handoffs.planFor(cmd("send_money")) is HandoffPlan.CantOpen)
        assertFalse(Handoffs.isPhoneKind(cmd("reachy_wake")))
        assertTrue(Handoffs.isPhoneKind(cmd("open_url")))
        assertTrue(Handoffs.isPhoneKind(cmd("call_contact")))
    }

    @Test
    fun inboxHidesHandledDuplicatesAndOtherKinds() {
        val inbox = CommandInbox()
        val a = cmd("call_contact", id = "a", number = "5551234")
        val b = cmd("open_url", id = "b", url = "https://zoom.us/j/1")
        val r = cmd("reachy_wake", id = "r")
        assertEquals(listOf(a, b), inbox.visible(listOf(a, r, b, a)))
        assertTrue(inbox.markHandled("a"))
        assertFalse("second tap must not act again", inbox.markHandled("a"))
        assertTrue(inbox.isHandled("a"))
        assertEquals(listOf(b), inbox.visible(listOf(a, b)))
        // The brain is the source of truth: a command it stops listing is gone.
        assertEquals(emptyList<DeviceCommand>(), inbox.visible(emptyList()))
    }

    @Test
    fun inboxForgetsOldestBeyondCap() {
        val inbox = CommandInbox(maxRemembered = 2)
        inbox.markHandled("1"); inbox.markHandled("2"); inbox.markHandled("3")
        assertFalse(inbox.isHandled("1"))
        assertTrue(inbox.isHandled("2"))
        assertTrue(inbox.isHandled("3"))
    }
}
