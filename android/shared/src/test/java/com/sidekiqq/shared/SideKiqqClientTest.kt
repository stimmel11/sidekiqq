package com.sidekiqq.shared

import com.sidekiqq.shared.model.BriefKind
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
}
