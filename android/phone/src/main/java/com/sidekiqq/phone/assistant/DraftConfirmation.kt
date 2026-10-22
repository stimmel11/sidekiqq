package com.sidekiqq.phone.assistant

/**
 * Strict voice confirmation for sending drafts (ARCHITECTURE.md safety rules).
 *
 *  - Only one draft can be pending at a time, and only for [windowMs] after it was offered.
 *  - Only an exact "send it" (after normalizing case, punctuation and whitespace) confirms.
 *    "don't send it", "send it later", "yes" and "sure" do NOT confirm.
 *  - Any other utterance, or the window running out, cancels. The draft stays unsent on the server.
 */
class DraftConfirmation(
    private val windowMs: Long = 30_000,
    private val now: () -> Long = System::currentTimeMillis,
) {
    data class Pending(val draftId: String, val summary: String, val offeredAt: Long)

    sealed interface Decision {
        data class Confirmed(val draftId: String) : Decision
        data object Declined : Decision
        data object Expired : Decision
        data object NothingPending : Decision
    }

    @Volatile var pending: Pending? = null
        private set

    /** Registers a draft and returns the sentence to speak. */
    fun offer(draftId: String, summary: String): String {
        pending = Pending(draftId, summary, now())
        return promptFor(summary)
    }

    fun evaluate(transcript: String): Decision {
        val p = pending ?: return Decision.NothingPending
        pending = null // one shot: any answer consumes the pending draft
        if (now() - p.offeredAt > windowMs) return Decision.Expired
        return if (isSendIt(transcript)) Decision.Confirmed(p.draftId) else Decision.Declined
    }

    fun clear() { pending = null }

    companion object {
        private val ACCEPTED = setOf("send it")

        fun normalize(s: String): String =
            s.lowercase()
                .replace(Regex("[^a-z0-9' ]"), " ")
                .replace(Regex("\\s+"), " ")
                .trim()

        fun isSendIt(transcript: String): Boolean = normalize(transcript) in ACCEPTED

        fun promptFor(summary: String): String {
            val s = summary.trim().trimEnd('.', '?', '!')
            return "Send this: $s? Say 'send it' to confirm, or anything else to cancel."
        }
    }
}
