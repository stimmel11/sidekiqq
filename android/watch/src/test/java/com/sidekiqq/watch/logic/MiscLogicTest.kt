package com.sidekiqq.watch.logic

import com.sidekiqq.shared.model.Importance
import com.sidekiqq.shared.wear.WearAlert
import com.sidekiqq.shared.wear.WearProtocol
import com.sidekiqq.shared.wear.WearReply
import com.sidekiqq.watch.data.GlanceSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MiscLogicTest {

    // --- PushToTalk ---
    @Test fun shortPressLatchesLongPressSends() {
        assertEquals(PushToTalk.Release.LATCH, PushToTalk.onRelease(100))
        assertEquals(PushToTalk.Release.SEND, PushToTalk.onRelease(PushToTalk.TAP_THRESHOLD_MS))
        assertEquals(PushToTalk.Release.SEND, PushToTalk.onRelease(2_000))
    }

    @Test fun pcmDurationAt16kMono() {
        assertEquals(1_000L, PushToTalk.pcmDurationMs(32_000))
        assertEquals(true, PushToTalk.isTooShort(32_000 / 10)) // 100 ms
        assertEquals(false, PushToTalk.isTooShort(32_000))
        assertEquals(1_920_000, PushToTalk.maxPcmBytes())
    }

    // --- ComplicationMath ---
    @Test fun complicationText() {
        assertEquals("0", ComplicationMath.shortText(0))
        assertEquals("7", ComplicationMath.shortText(7))
        assertEquals("99+", ComplicationMath.shortText(150))
        assertEquals("--", ComplicationMath.shortText(-1))
        assertEquals(10f, ComplicationMath.rangedValue(42))
        assertEquals(0f, ComplicationMath.rangedValue(-3))
        assertEquals("1 follow-up needed", ComplicationMath.contentDescription(1))
    }

    // --- Payloads (maps :shared WearProtocol payloads to watch routes) ---
    @Test fun criticalFollowUpAlertRoutesToFollowUps() {
        val a = Payloads.fromWear(
            WearAlert(title = "Dana waiting", body = "9 days", importance = Importance.CRITICAL, followUpId = "f1"),
        )
        assertEquals(Importance.CRITICAL, a.importance)
        assertEquals(Payloads.ROUTE_FOLLOWUPS, a.route)
        assertEquals("f1", a.id)
    }

    @Test fun alertKindRouting() {
        fun route(kind: String?) = Payloads.routeFor(WearAlert(title = "t", body = "b", kind = kind))
        assertEquals(Payloads.ROUTE_COMMITMENTS, route("commitment_overdue"))
        assertEquals(Payloads.ROUTE_FOLLOWUPS, route("follow_up"))
        assertEquals(Payloads.ROUTE_TOP5, route("daily_brief"))
        assertNull(route("something_else"))
        assertNull(route(null))
    }

    @Test fun alertWireRoundTrip() {
        val wire = WearProtocol.encode(WearAlert(title = "X", body = "Y", importance = Importance.HIGH))
        assertEquals(Importance.HIGH, Payloads.parseAlert(wire)!!.importance)
        assertNull(Payloads.parseAlert("not json".toByteArray()))
    }

    @Test fun replyFallsBackSpokenToText() {
        val r = Payloads.fromWear(WearReply(text = "Long answer.", spoken = "", conversationId = "c1", source = "medallion"))!!
        assertEquals("Long answer.", r.spoken)
        assertEquals("medallion", r.source)
        assertEquals("c1", r.conversationId)
        assertNull(Payloads.fromWear(WearReply(text = "", spoken = " ", source = "phone")))
    }

    // --- GlanceSnapshot round trip ---
    @Test fun glanceSnapshotRoundTrip() {
        val s = GlanceSnapshot(
            listOf(GlanceSnapshot.GlanceItem("Send Acme pricing", Importance.HIGH)),
            overdueCount = 2, followUpCount = 4, fetchedAtMs = 123L,
        )
        assertEquals(s, GlanceSnapshot.fromJson(s.toJson()))
        assertEquals(GlanceSnapshot.EMPTY, GlanceSnapshot.fromJson("garbage"))
    }
}
