package com.sidekiqq.phone.reachy

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
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

/** Against the reachy_mini 1.12.0 daemon's response shapes (daemon/app/routers/apps.py). */
class ReachyDaemonHttpTest {

    private val host = ReachyLan.parseHost("reachy-mini.local")!!
    private val jsonHeaders = headersOf(HttpHeaders.ContentType, "application/json")

    @Test
    fun parsesCurrentAppStatus() {
        assertNull(ReachyDaemonHttp.parseCurrentApp("null"))
        assertEquals(
            DaemonApp("sidekiqq_reachy", "running"),
            ReachyDaemonHttp.parseCurrentApp(
                """{"info":{"name":"sidekiqq_reachy","source_kind":"installed","description":"","url":null,"extra":{}},"state":"running","error":null}"""
            ),
        )
        listOf("", "[]", "{}", """{"state":"running"}""", """{"info":{"name":""},"state":"running"}""", "<html>").forEach {
            try {
                ReachyDaemonHttp.parseCurrentApp(it)
                fail("should refuse '$it'")
            } catch (e: ReachyDaemonException.Refused) { /* expected */ }
        }
    }

    @Test
    fun detailIsShortAndClean() {
        assertEquals("An app is already running", ReachyDaemonHttp.detailOf("""{"detail":"An app is already running"}"""))
        assertEquals("no details", ReachyDaemonHttp.detailOf("""{"detail":[{"loc":["path"]}]}"""))
        assertEquals("no details", ReachyDaemonHttp.detailOf("Internal Server Error"))
        assertEquals(120, ReachyDaemonHttp.detailOf("""{"detail":"${"x".repeat(500)}"}""").length)
        assertEquals("ab", ReachyDaemonHttp.detailOf("{\"detail\":\"a\\u0007b\"}"))
    }

    @Test
    fun startsWithNoEvictAndSendsNoToken() = runTest {
        val seen = mutableListOf<String>()
        val engine = MockEngine { req ->
            seen += "${req.method.value} ${req.url}"
            assertNull(req.headers[HttpHeaders.Authorization])
            assertNull(req.headers[HttpHeaders.Cookie])
            when {
                req.method == HttpMethod.Get -> respond("null", HttpStatusCode.OK, jsonHeaders)
                else -> respond("""{"info":{"name":"sidekiqq_reachy","source_kind":"installed"},"state":"starting"}""", HttpStatusCode.OK, jsonHeaders)
            }
        }
        ReachyDaemonHttp(host, engine).use { d ->
            assertNull(d.currentApp())
            d.startApp(ReachyLan.APP_NAME)
        }
        assertEquals(
            listOf(
                "GET http://reachy-mini.local:8000/api/apps/current-app-status",
                "POST http://reachy-mini.local:8000/api/apps/start-app/sidekiqq_reachy/no-evict",
            ),
            seen,
        )
    }

    @Test
    fun oldDaemonWithoutNoEvictIsNotStartedTheEvictingWay() = runTest {
        val seen = mutableListOf<String>()
        val engine = MockEngine { req ->
            seen += req.url.encodedPath
            respond("""{"detail":"Not Found"}""", HttpStatusCode.NotFound, jsonHeaders)
        }
        ReachyDaemonHttp(host, engine).use { d ->
            try {
                d.startApp(ReachyLan.APP_NAME)
                fail("expected Refused")
            } catch (e: ReachyDaemonException.Refused) {
                assertEquals(404, e.status)
                assertEquals(ReachyDaemonHttp.OLD_DAEMON, e.detail)
            }
        }
        assertEquals(listOf("/api/apps/start-app/sidekiqq_reachy/no-evict"), seen)
    }

    @Test
    fun statusErrorsAreRefusals() = runTest {
        val engine = MockEngine { respond("Internal Server Error", HttpStatusCode.InternalServerError) }
        ReachyDaemonHttp(host, engine).use { d ->
            try {
                d.currentApp()
                fail("expected Refused")
            } catch (e: ReachyDaemonException.Refused) {
                assertEquals(500, e.status)
                assertEquals("no details", e.detail)
            }
        }
        assertEquals(
            DaemonApp("sidekiqq_reachy", "error"),
            ReachyDaemonHttp.parseCurrentApp("""{"info":{"name":"sidekiqq_reachy"},"state":"error","error":"ImportError: x"}"""),
        )
    }

    @Test
    fun refusalCarriesTheDaemonDetail() = runTest {
        val engine = MockEngine { respond("""{"detail":"An app is already running"}""", HttpStatusCode.BadRequest, jsonHeaders) }
        ReachyDaemonHttp(host, engine).use { d ->
            try {
                d.startApp(ReachyLan.APP_NAME)
                fail("expected Refused")
            } catch (e: ReachyDaemonException.Refused) {
                assertEquals(400, e.status)
                assertEquals("An app is already running", e.detail)
            }
        }
    }

    @Test
    fun redirectsAreNotFollowed() = runTest {
        var calls = 0
        val engine = MockEngine {
            calls++
            respond("", HttpStatusCode.Found, headersOf(HttpHeaders.Location, "https://evil.example/"))
        }
        ReachyDaemonHttp(host, engine).use { d ->
            try {
                d.currentApp()
                fail("expected Refused")
            } catch (e: ReachyDaemonException.Refused) {
                assertEquals(302, e.status)
            }
        }
        assertEquals(1, calls)
    }

    @Test
    fun networkErrorsAreUnreachable() = runTest {
        val engine = MockEngine { throw java.net.UnknownHostException("reachy-mini.local") }
        ReachyDaemonHttp(host, engine).use { d ->
            try {
                d.currentApp()
                fail("expected Unreachable")
            } catch (e: ReachyDaemonException.Unreachable) {
                assertTrue(e.message!!.isNotEmpty())
            }
        }
    }

    @Test
    fun onlyTheSideKiqqAppIsStarted() = runTest {
        val engine = MockEngine { respond("{}", HttpStatusCode.OK, jsonHeaders) }
        ReachyDaemonHttp(host, engine).use { d ->
            try {
                d.startApp("some_other_app")
                fail("expected IllegalArgumentException")
            } catch (e: IllegalArgumentException) { /* expected */ }
        }
    }
}
