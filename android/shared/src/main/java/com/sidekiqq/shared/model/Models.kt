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

/** Device kind. Serialized lowercase ("watch", "glasses", "medallion", "phone", "reachy"). */
@Serializable
enum class Device(val wire: String) {
    @SerialName("watch") WATCH("watch"),
    @SerialName("glasses") GLASSES("glasses"),
    @SerialName("medallion") MEDALLION("medallion"),
    @SerialName("phone") PHONE("phone"),
    /** Reachy Mini desktop robot (Python app in /reachy). Never used by the Android apps themselves. */
    @SerialName("reachy") REACHY("reachy"),
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

// ---- Drafts (GET /api/drafts) ----

/** Start and end (ISO-8601) of a calendar draft. */
@Serializable
data class DraftWhen(
    val start: String,
    val end: String,
)

/**
 * A pending draft from `GET /api/drafts`: an action the owner must confirm before
 * `POST /api/drafts/:id/approve` executes it.
 *
 * [readback] is the one sentence to speak or show before asking for confirmation. The brain builds
 * it in code (every recipient address in full, the subject, the time for calendar kinds), so prefer
 * it over composing your own from [to]/[subject]. It is also what `Action.summary` carries for
 * `draft_created`. Older brains don't send it, hence the empty default.
 *
 * [kind] is a plain string (see [DraftKind]) so a newer brain can add kinds without breaking
 * parsing; absent = "email". Don't offer to approve a kind you don't know.
 */
@Serializable
data class Draft(
    val id: String,
    val kind: String = DraftKind.EMAIL,
    val to: List<String> = emptyList(),
    val cc: List<String> = emptyList(),
    val subject: String = "",
    val body: String = "",
    val readback: String = "",
    /** Calendar kinds only. */
    val `when`: DraftWhen? = null,
    val client: String? = null,
    val createdAt: String,
)

object DraftKind {
    const val EMAIL = "email"
    const val CALENDAR_INVITE = "calendar_invite"
    const val CALENDAR_HOLD = "calendar_hold"
}

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

/** POST /api/devices/pair body, matching brain/src/app/api/devices/pair/route.ts. */
@Serializable
data class PairRequest(val code: String, val device: Device = Device.PHONE)

@Serializable
data class PairResponse(val token: String)

// ---- Device commands (GET/POST /api/commands, POST /api/commands/:id/ack) ----

/**
 * A command started on one device to run on another (e.g. "call Dana" said to the watch opens the
 * dialer on the phone). Every command is a hand-off: show [label] and act ONLY after the owner taps.
 * Never auto-launch, never dial with ACTION_CALL (use ACTION_DIAL), never send anything because of one.
 * For call_contact, show [number] on its own line (not only inside [label]). Treat a command as live
 * only while GET /api/commands still returns it (don't trust the device clock against [expiresAt]).
 *
 * [kind] is a plain string (see [CommandKind]) so a newer brain can add kinds without breaking
 * parsing; ignore kinds you don't know.
 */
@Serializable
data class DeviceCommand(
    val id: String,
    val at: String,
    val expiresAt: String,
    val kind: String,
    val label: String,
    val from: String,
    val url: String? = null,
    val number: String? = null,
    val name: String? = null,
    /** call_contact: "phone" or "whatsapp". */
    val app: String? = null,
    /** reachy_wake: "chat", "brief", "dance" or "game". */
    val activity: String? = null,
)

object CommandKind {
    const val OPEN_URL = "open_url"
    const val CALL_CONTACT = "call_contact"
    const val REACHY_WAKE = "reachy_wake"
}

/** Values for [DeviceCommand.app] / [CreateCommandRequest.app]. WhatsApp needs a "+" international number. */
object CallApp {
    const val PHONE = "phone"
    const val WHATSAPP = "whatsapp"
}

/** Values for [DeviceCommand.activity] / [CreateCommandRequest.activity]. */
object ReachyActivity {
    const val CHAT = "chat"
    const val BRIEF = "brief"
    const val DANCE = "dance"
    const val GAME = "game"
}

/** What the owner did with a command on its target device. */
@Serializable
enum class CommandResult {
    @SerialName("opened") OPENED,
    @SerialName("dismissed") DISMISSED,
    @SerialName("failed") FAILED,
}

/** Route to a specific paired device id, or to the most recently seen device of a kind. Give one, not both. */
@Serializable
data class CommandTarget(
    val deviceId: String? = null,
    val device: Device? = null,
)

@Serializable
data class CreateCommandRequest(
    val kind: String,
    val target: CommandTarget? = null,
    val url: String? = null,
    val number: String? = null,
    val name: String? = null,
    val app: String? = null,
    val activity: String? = null,
)

@Serializable
data class CreateCommandResponse(
    val command: DeviceCommand,
    val deviceId: String,
    /** Device kind as a plain string ("phone", "reachy", ...) so a new kind can't break parsing. */
    val device: String,
)

@Serializable
data class AckCommandRequest(val result: CommandResult)
