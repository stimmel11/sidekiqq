package com.sidekiqq.shared

import com.sidekiqq.shared.model.BriefKind
import com.sidekiqq.shared.model.CommandKind
import com.sidekiqq.shared.model.CommandResult
import com.sidekiqq.shared.model.CommandTarget
import com.sidekiqq.shared.model.CreateCommandRequest
import com.sidekiqq.shared.model.CommitmentStatus
import com.sidekiqq.shared.model.Device
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SideKiqqClientTest {

    private val jsonHeaders = headersOf(HttpHeaders.ContentType, "application/json")

    @Test
    fun askSendsBearerAndBody() = runTest {
        var seenAuth: String? = null
        var seenBody = ""
        val engine = MockEngine { req ->
            assertEquals("https://brain.test/api/ask", req.url.toString())
            assertEquals(HttpMethod.Post, req.method)
            seenAuth = req.headers[HttpHeaders.Authorization]
            seenBody = req.body.toByteArray().decodeToString()
            respond("""{"reply":"r","spoken":"s","conversationId":"c","actions":[]}""", HttpStatusCode.OK, jsonHeaders)
        }
        val client = SideKiqqClient("https://brain.test/", { "tkn" }, engine)
        val res = client.ask("hello", Device.GLASSES)
        assertEquals("Bearer tkn", seenAuth)
        assertTrue(seenBody.contains("\"device\":\"glasses\""))
        assertEquals("s", res.spoken)
    }

    @Test
    fun transcribeSendsWav() = runTest {
        val engine = MockEngine { req ->
            assertEquals("audio/wav", req.body.contentType.toString())
            respond("""{"text":"call dana"}""", HttpStatusCode.OK, jsonHeaders)
        }
        val client = SideKiqqClient("https://brain.test", { "t" }, engine)
        assertEquals("call dana", client.transcribe(ByteArray(44)))
    }

    @Test
    fun queryParamsAndPaths() = runTest {
        val urls = mutableListOf<String>()
        val engine = MockEngine { req ->
            urls += req.url.toString()
            val body = when (req.url.encodedPath) {
                "/api/commitments" -> """{"items":[]}"""
                "/api/brief" -> """{"kind":"weekly","generatedAt":"x","sections":[],"top5":[]}"""
                else -> """{"ok":true}"""
            }
            respond(body, HttpStatusCode.OK, jsonHeaders)
        }
        val client = SideKiqqClient("https://brain.test", { null }, engine)
        client.commitments(CommitmentStatus.ALL)
        client.commitments()
        client.brief(BriefKind.WEEKLY)
        client.completeCommitment("c 1")
        client.approveDraft("d1")
        assertEquals("https://brain.test/api/commitments?status=all", urls[0])
        assertEquals("https://brain.test/api/commitments?status=open", urls[1])
        assertEquals("https://brain.test/api/brief?kind=weekly", urls[2])
        assertEquals("https://brain.test/api/commitments/c%201/complete", urls[3])
        assertEquals("https://brain.test/api/drafts/d1/approve", urls[4])
    }

    @Test
    fun pairHasNoAuthAndReturnsToken() = runTest {
        val bodies = mutableListOf<String>()
        val engine = MockEngine { req ->
            assertNull(req.headers[HttpHeaders.Authorization])
            bodies += req.body.toByteArray().decodeToString()
            respond("""{"token":"long-lived"}""", HttpStatusCode.OK, jsonHeaders)
        }
        val client = SideKiqqClient("https://brain.test", { "should-not-be-sent" }, engine)
        assertEquals("long-lived", client.pair("123456"))
        assertEquals("long-lived", client.pair(" 654321 ", Device.WATCH))
        assertTrue(bodies[0].contains("\"device\":\"phone\""))
        assertTrue(bodies[1].contains("\"code\":\"654321\""))
        assertTrue(bodies[1].contains("\"device\":\"watch\""))
    }

    @Test
    fun non2xxThrows() = runTest {
        val engine = MockEngine { respond("""{"error":"unauthorized"}""", HttpStatusCode.Unauthorized, jsonHeaders) }
        val client = SideKiqqClient("https://brain.test", { "bad" }, engine)
        try {
            client.top5()
            fail("expected exception")
        } catch (e: SideKiqqApiException) {
            assertEquals(401, e.status)
        }
    }

    @Test
    fun commandsRoundTrip() = runTest {
        val seen = mutableListOf<Pair<String, String>>()
        val cmd = """{"id":"cmd_1","at":"2026-10-24T10:00:00.000Z","expiresAt":"2026-10-24T10:15:00.000Z",""" +
            """"kind":"call_contact","label":"Call Dana Lee (+13035550142)","from":"watch","number":"+13035550142","name":"Dana Lee","app":"phone"}"""
        val engine = MockEngine { req ->
            seen += req.url.toString() to req.body.toByteArray().decodeToString()
            val body = when {
                req.method == HttpMethod.Post && req.url.encodedPath == "/api/commands" ->
                    """{"command":$cmd,"deviceId":"dev_p","device":"phone"}"""
                req.url.encodedPath == "/api/commands" ->
                    // An unknown future kind and extra fields must still parse.
                    """{"items":[$cmd,{"id":"cmd_2","at":"a","expiresAt":"b","kind":"future_kind","label":"L","from":"phone","extra":1}]}"""
                else -> """{"ok":true}"""
            }
            respond(body, HttpStatusCode.OK, jsonHeaders)
        }
        val client = SideKiqqClient("https://brain.test", { "t" }, engine)
        val created = client.createCommand(
            CreateCommandRequest(kind = CommandKind.CALL_CONTACT, number = "303 555 0142", name = "Dana Lee", target = CommandTarget(device = Device.PHONE)),
        )
        assertEquals("dev_p", created.deviceId)
        assertEquals("phone", created.device)
        assertEquals("+13035550142", created.command.number)
        // Nulls are omitted, not sent as null (the brain rejects null for optional fields).
        assertTrue(seen[0].second.contains("\"target\":{\"device\":\"phone\"}"))
        assertTrue(!seen[0].second.contains("null"))

        val pending = client.commands(limit = 5)
        assertEquals("https://brain.test/api/commands?limit=5", seen[1].first)
        assertEquals(listOf("call_contact", "future_kind"), pending.map { it.kind })

        client.ackCommand("cmd_1", CommandResult.OPENED)
        assertEquals("https://brain.test/api/commands/cmd_1/ack", seen[2].first)
        assertEquals("""{"result":"opened"}""", seen[2].second)
    }
}
