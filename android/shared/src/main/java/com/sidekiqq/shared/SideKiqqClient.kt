package com.sidekiqq.shared

import com.sidekiqq.shared.model.AckCommandRequest
import com.sidekiqq.shared.model.AskRequest
import com.sidekiqq.shared.model.AskResponse
import com.sidekiqq.shared.model.Brief
import com.sidekiqq.shared.model.BriefKind
import com.sidekiqq.shared.model.CommandResult
import com.sidekiqq.shared.model.Commitment
import com.sidekiqq.shared.model.CommitmentStatus
import com.sidekiqq.shared.model.CreateCommandRequest
import com.sidekiqq.shared.model.CreateCommandResponse
import com.sidekiqq.shared.model.Device
import com.sidekiqq.shared.model.DeviceCommand
import com.sidekiqq.shared.model.FollowUp
import com.sidekiqq.shared.model.ItemsResponse
import com.sidekiqq.shared.model.PairRequest
import com.sidekiqq.shared.model.PairResponse
import com.sidekiqq.shared.model.RegisterDeviceRequest
import com.sidekiqq.shared.model.Top5Response
import com.sidekiqq.shared.model.TranscribeResponse
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.content.ByteArrayContent
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json

/** Thrown for any non-2xx response from the brain. */
class SideKiqqApiException(val status: Int, val responseBody: String) :
    RuntimeException("SideKiqq API error $status: ${responseBody.take(300)}")

/**
 * Thin client for the SideKiqq brain. Shared by the phone and watch apps.
 *
 * @param baseUrl e.g. "https://sidekiqq.vercel.app" (trailing slash optional)
 * @param tokenProvider returns the device bearer token, or null before pairing
 * @param engine override for tests (Ktor MockEngine); defaults to OkHttp
 */
class SideKiqqClient(
    baseUrl: String,
    private val tokenProvider: () -> String?,
    engine: HttpClientEngine? = null,
) : AutoCloseable {

    private val root: String = baseUrl.trim().trimEnd('/')

    // When we create the engine ourselves we also own closing it.
    private val ownedEngine: HttpClientEngine? = if (engine == null) OkHttp.create() else null

    private val http: HttpClient = run {
        val config: io.ktor.client.HttpClientConfig<*>.() -> Unit = {
            expectSuccess = false
            install(ContentNegotiation) { json(SideKiqqJson) }
            install(HttpTimeout) {
                connectTimeoutMillis = 15_000
                // /api/ask runs Claude with tool calls; give it room.
                requestTimeoutMillis = 90_000
                socketTimeoutMillis = 90_000
            }
            defaultRequest { header(HttpHeaders.Accept, ContentType.Application.Json.toString()) }
        }
        HttpClient(engine ?: ownedEngine!!, config)
    }

    private fun HttpRequestBuilder.auth() {
        tokenProvider()?.let { header(HttpHeaders.Authorization, "Bearer $it") }
    }

    private suspend fun HttpResponse.ensureOk(): HttpResponse {
        if (!status.isSuccess()) throw SideKiqqApiException(status.value, bodyAsText())
        return this
    }

    // Only the 2xx status matters for {"ok":true} endpoints; don't fail on an empty/odd body.
    private suspend fun HttpResponse.ensureOkUnit() {
        ensureOk()
    }

    private fun url(path: String) = "$root$path"

    // ---------------------------------------------------------------- API

    suspend fun ask(text: String, device: Device, conversationId: String? = null): AskResponse =
        http.post(url("/api/ask")) {
            auth()
            contentType(ContentType.Application.Json)
            setBody(AskRequest(text = text, device = device, conversationId = conversationId))
        }.ensureOk().body()

    /** [wav] must be a complete RIFF/WAV file (16 kHz mono PCM16) — see [com.sidekiqq.shared.audio.WavEncoder]. */
    suspend fun transcribe(wav: ByteArray): String =
        http.post(url("/api/transcribe")) {
            auth()
            setBody(ByteArrayContent(wav, ContentType("audio", "wav")))
        }.ensureOk().body<TranscribeResponse>().text

    suspend fun top5(): Top5Response =
        http.get(url("/api/top5")) { auth() }.ensureOk().body()

    suspend fun followUps(): List<FollowUp> =
        http.get(url("/api/followups")) { auth() }.ensureOk().body<ItemsResponse<FollowUp>>().items

    suspend fun commitments(status: CommitmentStatus = CommitmentStatus.OPEN): List<Commitment> =
        http.get(url("/api/commitments")) {
            auth()
            parameter("status", status.wire)
        }.ensureOk().body<ItemsResponse<Commitment>>().items

    suspend fun completeCommitment(id: String) {
        http.post(url("/api/commitments/${id.encodeURLPathPart()}/complete")) { auth() }.ensureOkUnit()
    }

    /**
     * Sends a drafted message. This is the ONLY call that causes anything to be sent on the user's
     * behalf. Callers MUST obtain an explicit user confirmation immediately before invoking it.
     */
    suspend fun approveDraft(id: String) {
        http.post(url("/api/drafts/${id.encodeURLPathPart()}/approve")) { auth() }.ensureOkUnit()
    }

    suspend fun brief(kind: BriefKind): Brief =
        http.get(url("/api/brief")) {
            auth()
            parameter("kind", kind.wire)
        }.ensureOk().body()

    suspend fun registerDevice(fcmToken: String, device: Device) {
        http.post(url("/api/devices/register")) {
            auth()
            contentType(ContentType.Application.Json)
            setBody(RegisterDeviceRequest(fcmToken = fcmToken, device = device))
        }.ensureOkUnit()
    }

    /**
     * Queues a command to run on another device (POST /api/commands). The brain validates it and
     * builds the label; the target only acts after the owner taps. Sends nothing by itself.
     */
    suspend fun createCommand(request: CreateCommandRequest): CreateCommandResponse =
        http.post(url("/api/commands")) {
            auth()
            contentType(ContentType.Application.Json)
            setBody(request)
        }.ensureOk().body()

    /** This device's pending, unexpired commands, oldest first (GET /api/commands). Dedupe by id. */
    suspend fun commands(limit: Int = 20): List<DeviceCommand> =
        http.get(url("/api/commands")) {
            auth()
            parameter("limit", limit)
        }.ensureOk().body<ItemsResponse<DeviceCommand>>().items

    /** Reports what the owner did with a command (POST /api/commands/:id/ack). 410 = it expired. */
    suspend fun ackCommand(id: String, result: CommandResult) {
        http.post(url("/api/commands/${id.encodeURLPathPart()}/ack")) {
            auth()
            contentType(ContentType.Application.Json)
            setBody(AckCommandRequest(result))
        }.ensureOkUnit()
    }

    /**
     * Exchanges a one-time pairing code for a long-lived device token.
     * POST /api/devices/pair {"code","device"} -> {"token", ...} (see brain/src/app/api/devices/pair/route.ts).
     * [device] labels the token on the brain side ("phone" or "watch").
     */
    suspend fun pair(code: String, device: Device = Device.PHONE): String =
        http.post(url("/api/devices/pair")) {
            contentType(ContentType.Application.Json)
            setBody(PairRequest(code = code.trim(), device = device))
        }.ensureOk().body<PairResponse>().token

    override fun close() {
        http.close()
        ownedEngine?.close()
    }
}

/** The JSON configuration used on the wire. Lenient on input so brain additions don't break clients. */
@OptIn(ExperimentalSerializationApi::class)
val SideKiqqJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    coerceInputValues = true
    isLenient = true
}
