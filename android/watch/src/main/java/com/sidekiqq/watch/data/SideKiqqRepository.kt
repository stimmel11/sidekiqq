package com.sidekiqq.watch.data

import com.sidekiqq.shared.SideKiqqClient
import com.sidekiqq.shared.model.AskResponse
import com.sidekiqq.shared.model.Commitment
import com.sidekiqq.shared.model.CommitmentStatus
import com.sidekiqq.shared.model.Device
import com.sidekiqq.shared.model.FollowUp
import com.sidekiqq.shared.model.Top5Response
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/**
 * The watch's single entry point to the brain. Every call is direct HTTPS. On LTE/Wi-Fi it goes
 * straight out; when tethered, Wear OS routes it through the phone's Bluetooth proxy, so the code
 * path is the same. Also keeps [GlanceCache] fresh for the tile and complication.
 */
class SideKiqqRepository(
    private val prefs: WatchPrefs,
    private val glance: GlanceCache,
) {
    // Rebuilt if the base URL changes (the phone can push a new one with the token).
    @Volatile private var client: SideKiqqClient? = null
    @Volatile private var clientUrl: String? = null

    @Synchronized
    private fun client(): SideKiqqClient {
        val url = prefs.baseUrl
        val existing = client
        if (existing != null && clientUrl == url) return existing
        existing?.close() // SideKiqqClient is AutoCloseable (owns an OkHttp engine)
        return SideKiqqClient(baseUrl = url, tokenProvider = prefs.tokenProvider).also {
            client = it
            clientUrl = url
        }
    }

    val isPaired: Boolean get() = prefs.token != null

    suspend fun transcribe(wav: ByteArray): String = client().transcribe(wav)

    suspend fun ask(text: String): AskResponse {
        val resp = client().ask(text = text, device = Device.WATCH, conversationId = prefs.conversationId)
        prefs.conversationId = resp.conversationId
        return resp
    }

    fun resetConversation() {
        prefs.conversationId = null
    }

    suspend fun top5(): Top5Response = client().top5()

    suspend fun followUps(): List<FollowUp> = client().followUps().also { list ->
        glance.update { it.copy(followUpCount = list.size, fetchedAtMs = System.currentTimeMillis()) }
    }

    /** Open and overdue together, deduplicated by id, for the Commitments screen. */
    suspend fun openAndOverdue(): List<Commitment> = coroutineScope {
        val open = async { client().commitments(CommitmentStatus.OPEN) }
        val overdue = async { client().commitments(CommitmentStatus.OVERDUE) }
        (overdue.await() + open.await()).distinctBy { it.id }
    }.also { list ->
        val overdueCount = list.count { it.status == CommitmentStatus.OVERDUE }
        glance.update { it.copy(overdueCount = overdueCount, fetchedAtMs = System.currentTimeMillis()) }
    }

    suspend fun completeCommitment(id: String) = client().completeCommitment(id)

    /** Sends a drafted message. Only ApproveFlow's confirm step may call this. */
    suspend fun approveDraft(id: String) = client().approveDraft(id)

    /** Standalone pairing. The brain labels the resulting token as a "watch" device. */
    suspend fun pair(code: String): String = client().pair(code, Device.WATCH).also { prefs.token = it }

    /** Fetches what the tile and complication need in parallel, and caches it. */
    suspend fun refreshGlance(): GlanceSnapshot = coroutineScope {
        val top = async { client().top5() }
        val overdue = async { client().commitments(CommitmentStatus.OVERDUE) }
        val follow = async { client().followUps() }
        GlanceSnapshot(
            top = top.await().items.take(3).map { GlanceSnapshot.GlanceItem(it.title, it.importance) },
            overdueCount = overdue.await().size,
            followUpCount = follow.await().size,
            fetchedAtMs = System.currentTimeMillis(),
        ).also(glance::write)
    }

    fun cachedGlance(): GlanceSnapshot = glance.read()
}
