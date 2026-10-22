package com.sidekiqq.shared

import com.sidekiqq.shared.model.Action
import com.sidekiqq.shared.model.ActionType
import com.sidekiqq.shared.model.AskRequest
import com.sidekiqq.shared.model.AskResponse
import com.sidekiqq.shared.model.Brief
import com.sidekiqq.shared.model.BriefKind
import com.sidekiqq.shared.model.Commitment
import com.sidekiqq.shared.model.CommitmentStatus
import com.sidekiqq.shared.model.Confidence
import com.sidekiqq.shared.model.Device
import com.sidekiqq.shared.model.FollowUp
import com.sidekiqq.shared.model.Importance
import com.sidekiqq.shared.model.ItemsResponse
import com.sidekiqq.shared.model.RegisterDeviceRequest
import com.sidekiqq.shared.model.SourceKind
import com.sidekiqq.shared.model.Top5Response
import com.sidekiqq.shared.wear.WearAlert
import com.sidekiqq.shared.wear.WearProtocol
import com.sidekiqq.shared.wear.WearReply
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonSerializationTest {

    private val json = SideKiqqJson

    private fun obj(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject

    @Test
    fun deviceSerializesLowercase() {
        for (d in Device.entries) {
            assertEquals("\"${d.name.lowercase()}\"", json.encodeToString(Device.serializer(), d))
        }
    }

    @Test
    fun askRequestShape() {
        val o = obj(json.encodeToString(AskRequest.serializer(), AskRequest("hi", Device.MEDALLION)))
        assertEquals("hi", o["text"]!!.jsonPrimitive.content)
        assertEquals("medallion", o["device"]!!.jsonPrimitive.content)
        // explicitNulls = false: absent conversationId must not be sent as null
        assertFalse(o.containsKey("conversationId"))

        val o2 = obj(json.encodeToString(AskRequest.serializer(), AskRequest("hi", Device.WATCH, "c1")))
        assertEquals("c1", o2["conversationId"]!!.jsonPrimitive.content)
    }

    @Test
    fun registerDeviceShape() {
        val o = obj(json.encodeToString(RegisterDeviceRequest.serializer(), RegisterDeviceRequest("tok", Device.PHONE)))
        assertEquals("tok", o["fcmToken"]!!.jsonPrimitive.content)
        assertEquals("phone", o["device"]!!.jsonPrimitive.content)
    }

    @Test
    fun askResponseDecodes() {
        val r = json.decodeFromString(
            AskResponse.serializer(),
            """{"reply":"Long reply","spoken":"Short.","conversationId":"abc",
               "actions":[{"type":"draft_created","id":"d1","summary":"Reply to Dana"},
                          {"type":"commitment_added","id":"c9","summary":"Send pricing Fri"}],
               "extraFieldFromNewerBrain": 42}"""
        )
        assertEquals("Short.", r.spoken)
        assertEquals(listOf(
            Action(ActionType.DRAFT_CREATED, "d1", "Reply to Dana"),
            Action(ActionType.COMMITMENT_ADDED, "c9", "Send pricing Fri"),
        ), r.actions)
    }

    @Test
    fun commitmentDecodesWithOptionalsMissing() {
        val items = json.decodeFromString(
            ItemsResponse.serializer(Commitment.serializer()),
            """{"items":[{"id":"1","who":"Chris","what":"Send revised proposal","madeAt":"2026-10-10T15:00:00Z",
               "dueInferred":true,"status":"overdue","source":{"kind":"email","ref":"msg-1"},"confidence":"INFERRED"},
               {"id":"2","who":"Dana","what":"Send deposit","madeAt":"2026-10-11T15:00:00Z","dueAt":"2026-10-20",
               "dueInferred":false,"status":"open","client":"ABC","source":{"kind":"voice"},"confidence":"CONFIRMED"}]}"""
        ).items
        assertEquals(2, items.size)
        assertEquals(CommitmentStatus.OVERDUE, items[0].status)
        assertTrue(items[0].dueInferred)
        assertNull(items[0].dueAt)
        assertEquals(Confidence.INFERRED, items[0].confidence)
        assertEquals(SourceKind.VOICE, items[1].source.kind)
        assertNull(items[1].source.ref)
        assertEquals("ABC", items[1].client)
    }

    @Test
    fun followUpAndTop5Decode() {
        val f = json.decodeFromString(
            ItemsResponse.serializer(FollowUp.serializer()),
            """{"items":[{"id":"f1","person":"Dana","reason":"No reply in 9 days","daysQuiet":9,
               "importance":"HIGH","suggestedMessage":"Hi Dana...","draftId":"d1"}]}"""
        ).items.single()
        assertEquals(Importance.HIGH, f.importance)
        assertEquals("d1", f.draftId)

        val t = json.decodeFromString(
            Top5Response.serializer(),
            """{"items":[{"id":"t1","title":"Call Dana","why":"Proposal stalled","importance":"CRITICAL"}],
               "updatedAt":"2026-10-16T12:00:00Z"}"""
        )
        assertEquals(Importance.CRITICAL, t.items.single().importance)
    }

    @Test
    fun briefDecodes() {
        val b = json.decodeFromString(
            Brief.serializer(),
            """{"kind":"daily","generatedAt":"2026-10-16T12:00:00Z",
               "sections":[{"title":"TODAY","items":["9:00 call with Dana"]}],
               "top5":[{"id":"t1","title":"Call Dana","why":"stalled","importance":"HIGH","dueAt":"2026-10-16"}]}"""
        )
        assertEquals(BriefKind.DAILY, b.kind)
        assertEquals("TODAY", b.sections.single().title)
        assertEquals("2026-10-16", b.top5.single().dueAt)
    }

    @Test
    fun commitmentRoundTrip() {
        val c = Commitment(
            id = "x", who = "Chris", what = "Send W-9", madeAt = "2026-10-16T00:00:00Z",
            dueAt = null, dueInferred = true, status = CommitmentStatus.OPEN, client = "ABC",
            project = null, source = com.sidekiqq.shared.model.CommitmentSource(SourceKind.MEETING),
            confidence = Confidence.LIKELY,
        )
        val s = json.encodeToString(Commitment.serializer(), c)
        assertTrue(s.contains("\"status\":\"open\""))
        assertTrue(s.contains("\"kind\":\"meeting\""))
        assertEquals(c, json.decodeFromString(Commitment.serializer(), s))
    }

    @Test
    fun wearPayloadsRoundTrip() {
        val a = WearAlert("Dana went quiet", "9 days since proposal", Importance.HIGH, "followup", "f1", "d1")
        assertEquals(a, WearProtocol.decodeAlert(WearProtocol.encode(a)))
        val r = WearReply("reply", "spoken", "c1", "medallion")
        assertEquals(r, WearProtocol.decodeReply(WearProtocol.encode(r)))
    }
}
