package com.sidekiqq.phone.reachy

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpRequestTimeoutException
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.io.Closeable
import java.io.IOException
import java.nio.channels.UnresolvedAddressException

/**
 * The Reachy Mini daemon's REST API (reachy_mini 1.12.0, `daemon/app/routers/apps.py`), over plain
 * HTTP on the home LAN. Only two calls: read the current app and start an app.
 *
 * - No SideKiqq token, cookie or owner data is ever sent to the daemon.
 * - Redirects are not followed, so the daemon can't bounce the phone to another host.
 * - Start uses only `/start-app/{name}/no-evict`, which fails instead of kicking out a remote
 *   session (for example the Reachy mobile app). The plain `/start-app/{name}` evicts one, so it is
 *   never used: a daemon without `no-evict` answers 404 and the owner is asked to update Reachy.
 *   The daemon also refuses (400) while any app is running, so nothing running is ever stopped.
 */
class ReachyDaemonHttp(
    private val host: ReachyHost,
    engine: HttpClientEngine = OkHttp.create(),
) : ReachyDaemon, Closeable {

    private val http = HttpClient(engine) {
        expectSuccess = false
        followRedirects = false
        install(HttpTimeout) {
            connectTimeoutMillis = 4_000
            requestTimeoutMillis = 10_000
            socketTimeoutMillis = 10_000
        }
    }

    override suspend fun currentApp(): DaemonApp? {
        val (status, text) = call { http.get("${host.baseUrl}/api/apps/current-app-status") }
        if (status != 200) throw ReachyDaemonException.Refused(status, detailOf(text))
        return parseCurrentApp(text)
    }

    override suspend fun startApp(name: String) {
        require(name == ReachyLan.APP_NAME) { "only the SideKiqq app is started" }
        val (status, text) = call { http.post("${host.baseUrl}/api/apps/start-app/$name/no-evict") }
        if (status == 404) throw ReachyDaemonException.Refused(404, OLD_DAEMON)
        if (status !in 200..299) throw ReachyDaemonException.Refused(status, detailOf(text))
    }

    override fun close() = http.close()

    /** Runs the request AND reads the body, so a reset mid-body is also [ReachyDaemonException.Unreachable]. */
    private suspend fun call(block: suspend () -> HttpResponse): Pair<Int, String> = try {
        val r = block()
        r.status.value to r.bodyAsText()
    } catch (e: HttpRequestTimeoutException) {
        throw ReachyDaemonException.Unreachable("timed out")
    } catch (e: IOException) {
        throw ReachyDaemonException.Unreachable(e.message ?: "network error")
    } catch (e: UnresolvedAddressException) {
        throw ReachyDaemonException.Unreachable("name not found")
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        const val OLD_DAEMON = "its software is too old to start apps safely. Update Reachy from its dashboard."

        /**
         * `null` (no app) or `{"info": {"name": ..., ...}, "state": "running", "error": null}`.
         * Anything else is treated as a refusal, so the phone never guesses.
         */
        fun parseCurrentApp(text: String): DaemonApp? {
            val el = try { json.parseToJsonElement(text) } catch (e: Exception) {
                throw ReachyDaemonException.Refused(200, "unexpected reply")
            }
            if (el is JsonNull) return null
            val obj = el as? JsonObject ?: throw ReachyDaemonException.Refused(200, "unexpected reply")
            val name = ((obj["info"] as? JsonObject)?.get("name") as? JsonPrimitive)?.contentOrNull
            val state = (obj["state"] as? JsonPrimitive)?.contentOrNull
            if (name.isNullOrBlank() || state.isNullOrBlank()) throw ReachyDaemonException.Refused(200, "unexpected reply")
            return DaemonApp(name.take(80), state.lowercase())
        }

        /** FastAPI errors are `{"detail": "..."}`. Shortened, and control characters dropped. */
        fun detailOf(text: String): String {
            val d = try {
                ((json.parseToJsonElement(text) as? JsonObject)?.get("detail") as? JsonPrimitive)?.contentOrNull
            } catch (e: Exception) { null }
            return (d ?: "no details").filter { !it.isISOControl() }.take(120)
        }
    }
}
