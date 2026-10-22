package com.sidekiqq.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/*
 * Kotlin mirrors of the Brain API models in ARCHITECTURE.md.
 * Field names match the JSON exactly; optional TS fields are nullable with a null default.
 */

@Serializable
enum class Importance { CRITICAL, HIGH, MEDIUM, LOW, FYI }

@Serializable
enum class Confidence { CONFIRMED, LIKELY, INFERRED, UNKNOWN }

/** Device kind. Serialized lowercase ("watch", "glasses", "medallion", "phone"). */
@Serializable
enum class Device(val wire: String) {
    @SerialName("watch") WATCH("watch"),
    @SerialName("glasses") GLASSES("glasses"),
    @SerialName("medallion") MEDALLION("medallion"),
    @SerialName("phone") PHONE("phone"),
}

/**
 * Commitment status. OPEN / DONE / OVERDUE appear on [Commitment.status].
 * ALL exists only as a `?status=all` query filter and never appears in a payload.
 */
@Serializable
enum class CommitmentStatus(val wire: String) {
    @SerialName("open") OPEN("open"),
    @SerialName("done") DONE("done"),
    @SerialName("overdue") OVERDUE("overdue"),
    @SerialName("all") ALL("all"),
}

@Serializable
enum class SourceKind {
    @SerialName("email") EMAIL,
    @SerialName("meeting") MEETING,
    @SerialName("voice") VOICE,
}

@Serializable
data class CommitmentSource(
    val kind: SourceKind,
    val ref: String? = null,
)

@Serializable
data class Commitment(
    val id: String,
    val who: String,
    val what: String,
    val madeAt: String,
    val dueAt: String? = null,
    val dueInferred: Boolean = false,
    val status: CommitmentStatus,
    val client: String? = null,
    val project: String? = null,
    val source: CommitmentSource,
    val confidence: Confidence,
)

@Serializable
data class FollowUp(
    val id: String,
    val person: String,
    val client: String? = null,
    val reason: String,
    val daysQuiet: Int? = null,
    val importance: Importance,
    val suggestedMessage: String? = null,
    val draftId: String? = null,
)

@Serializable
data class TopItem(
    val id: String,
    val title: String,
    val why: String,
    val importance: Importance,
    val dueAt: String? = null,
)

@Serializable
enum class ActionType {
    @SerialName("draft_created") DRAFT_CREATED,
    @SerialName("commitment_added") COMMITMENT_ADDED,
    @SerialName("event_proposed") EVENT_PROPOSED,
}

@Serializable
data class Action(
    val type: ActionType,
    val id: String,
    val summary: String,
)

@Serializable
enum class BriefKind(val wire: String) {
    @SerialName("daily") DAILY("daily"),
    @SerialName("eod") EOD("eod"),
    @SerialName("weekly") WEEKLY("weekly"),
}

@Serializable
data class BriefSection(
    val title: String,
    val items: List<String> = emptyList(),
)

@Serializable
data class Brief(
    val kind: BriefKind,
    val generatedAt: String,
    val sections: List<BriefSection> = emptyList(),
    val top5: List<TopItem> = emptyList(),
)

@Serializable
data class AskResponse(
    val reply: String,
    val spoken: String,
    val conversationId: String,
    val actions: List<Action> = emptyList(),
)

@Serializable
data class Top5Response(
    val items: List<TopItem> = emptyList(),
    val updatedAt: String,
)

// ---- Request / envelope types (wire-only) ----

@Serializable
data class AskRequest(
    val text: String,
    val device: Device,
    val conversationId: String? = null,
)

@Serializable
data class TranscribeResponse(val text: String)

@Serializable
data class ItemsResponse<T>(val items: List<T> = emptyList())

@Serializable
data class OkResponse(val ok: Boolean = false)

@Serializable
data class RegisterDeviceRequest(val fcmToken: String, val device: Device)

/** ASSUMPTION: body/response of POST /api/devices/pair are not specified in ARCHITECTURE.md. */
@Serializable
data class PairRequest(val code: String, val device: Device = Device.PHONE)

@Serializable
data class PairResponse(val token: String)
