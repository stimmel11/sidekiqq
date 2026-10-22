package com.sidekiqq.watch.logic

import com.sidekiqq.shared.wear.WearAlert
import com.sidekiqq.shared.wear.WearProtocol
import com.sidekiqq.shared.wear.WearReply

/**
 * Watch-side views of the phone -> watch Data Layer payloads. The wire contract (paths, JSON
 * shape) is owned by :shared `WearProtocol`, which the phone also uses. This file only decodes it
 * leniently and maps it to what the watch UI needs (e.g. which screen a notification opens).
 */
data class AlertPayload(
    val id: String,
    val title: String,
    val body: String,
    val importance: com.sidekiqq.shared.model.Importance,
    val route: String?,
)

data class ReplyPayload(
    val source: String?,
    val spoken: String,
    val reply: String,
    val conversationId: String?,
)

object Payloads {

    /** Screen routes. They must match ui.Routes, duplicated here so this file stays pure. */
    const val ROUTE_FOLLOWUPS = "followups"
    const val ROUTE_COMMITMENTS = "commitments"
    const val ROUTE_TOP5 = "top5"

    fun parseAlert(bytes: ByteArray): AlertPayload? =
        runCatching { fromWear(WearProtocol.decodeAlert(bytes)) }.getOrNull()

    fun parseReply(bytes: ByteArray): ReplyPayload? =
        runCatching { fromWear(WearProtocol.decodeReply(bytes)) }.getOrNull()

    fun fromWear(a: WearAlert): AlertPayload = AlertPayload(
        id = a.followUpId ?: a.draftId ?: "${a.title}|${a.body}".hashCode().toString(),
        title = a.title.ifBlank { "SideKiqq" },
        body = a.body,
        importance = a.importance,
        route = routeFor(a),
    )

    /** Alerts about a follow-up or draft open Follow-ups (which still needs Approve then confirm). */
    fun routeFor(a: WearAlert): String? {
        if (a.followUpId != null || a.draftId != null) return ROUTE_FOLLOWUPS
        val k = a.kind?.lowercase() ?: return null
        return when {
            "follow" in k || "draft" in k -> ROUTE_FOLLOWUPS
            "commit" in k || "overdue" in k -> ROUTE_COMMITMENTS
            "top" in k || "brief" in k -> ROUTE_TOP5
            else -> null
        }
    }

    fun fromWear(r: WearReply): ReplyPayload? {
        val reply = r.text.trim()
        val spoken = r.spoken.trim().ifBlank { reply }
        if (reply.isEmpty() && spoken.isEmpty()) return null
        return ReplyPayload(
            source = r.source.ifBlank { null },
            spoken = spoken,
            reply = reply.ifBlank { spoken },
            conversationId = r.conversationId,
        )
    }
}
