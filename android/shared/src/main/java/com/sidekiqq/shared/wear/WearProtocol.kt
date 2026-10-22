package com.sidekiqq.shared.wear

import com.sidekiqq.shared.SideKiqqJson
import com.sidekiqq.shared.model.Action
import com.sidekiqq.shared.model.Importance
import kotlinx.serialization.Serializable

/**
 * Phone <-> watch Wearable Data Layer contract. Both apps depend on :shared, so both use
 * these exact constants and payload classes. Payloads are UTF-8 JSON (SideKiqqJson).
 */
object WearProtocol {
    /** MessageClient: phone -> watch proactive alert (from FCM). Payload: [WearAlert]. */
    const val PATH_ALERT = "/sidekiqq/alert"

    /** MessageClient: phone -> watch assistant reply (from medallion/glasses/phone). Payload: [WearReply]. */
    const val PATH_REPLY = "/sidekiqq/reply"

    /** DataClient DataItem: phone -> watch server config after pairing. Keys below. */
    const val PATH_CONFIG = "/sidekiqq/config"
    const val KEY_BASE_URL = "baseUrl"
    const val KEY_TOKEN = "token"

    fun encode(alert: WearAlert): ByteArray = SideKiqqJson.encodeToString(WearAlert.serializer(), alert).toByteArray()
    fun encode(reply: WearReply): ByteArray = SideKiqqJson.encodeToString(WearReply.serializer(), reply).toByteArray()
    fun decodeAlert(bytes: ByteArray): WearAlert = SideKiqqJson.decodeFromString(WearAlert.serializer(), bytes.decodeToString())
    fun decodeReply(bytes: ByteArray): WearReply = SideKiqqJson.decodeFromString(WearReply.serializer(), bytes.decodeToString())
}

@Serializable
data class WearAlert(
    val title: String,
    val body: String,
    val importance: Importance = Importance.MEDIUM,
    val kind: String? = null,
    val followUpId: String? = null,
    val draftId: String? = null,
)

@Serializable
data class WearReply(
    val text: String,
    val spoken: String,
    val conversationId: String? = null,
    /** "medallion" | "glasses" | "phone" */
    val source: String,
    val actions: List<Action> = emptyList(),
)
