package com.sidekiqq.phone.assistant

import com.sidekiqq.shared.model.Draft
import com.sidekiqq.shared.model.DraftKind

/**
 * Strict voice confirmation for sending drafts (ARCHITECTURE.md safety rules).
 *
 *  - Only one draft can be pending at a time, and only for [windowMs] after it was armed.
 *    Arm it right AFTER the read-back has been spoken, so the owner gets the whole window.
 *  - Only an exact "send it" (after normalizing case, punctuation and whitespace) confirms.
 *    "don't send it", "send it later", "yes" and "sure" do NOT confirm.
 *  - Speech that started before the window opened (over the read-back, or queued behind it)
 *    answers nothing the owner heard, so it declines. Unknown start time also declines.
 *  - Any other utterance, or the window running out, cancels. The draft stays unsent on the server.
 *
 * The read-back text matches `apple/SideKiqqKit` DraftConfirmation.swift line for line; the
 * brain-readback + "Message begins:" form is the same one `reachy/confirm.py` uses.
 */
class DraftConfirmation(
    private val windowMs: Long = 30_000,
    /** Must be the same clock as the `spokenAt` passed to [evaluate] (VoiceAssistant passes its own). */
    private val now: () -> Long = System::currentTimeMillis,
) {
    /** [fingerprint] = [fingerprint] of the draft as it was read back, checked again before approve. */
    data class Pending(val draftId: String, val summary: String, val offeredAt: Long, val fingerprint: String)

    sealed interface Decision {
        data class Confirmed(val draftId: String, val fingerprint: String) : Decision
        data object Declined : Decision
        data object Expired : Decision
        data object NothingPending : Decision
    }

    @Volatile var pending: Pending? = null
        private set

    /** Starts the confirmation window now for a draft whose read-back has just been heard. */
    fun arm(draft: Draft) {
        pending = Pending(draft.id, readback(draft), now(), fingerprint(draft))
    }

    /**
     * @param spokenAt when the owner started speaking this answer (same clock as [now]); null =
     *   unknown, which declines (fails closed).
     */
    fun evaluate(transcript: String, spokenAt: Long?): Decision {
        val p = pending ?: return Decision.NothingPending
        pending = null // one shot: any answer consumes the pending draft
        if (now() - p.offeredAt > windowMs) return Decision.Expired
        if (spokenAt == null || spokenAt < p.offeredAt) return Decision.Declined
        return if (isSendIt(transcript)) Decision.Confirmed(p.draftId, p.fingerprint) else Decision.Declined
    }

    fun clear() { pending = null }

    companion object {
        private val ACCEPTED = setOf("send it")

        const val CONFIRM_INSTRUCTION = "Say 'send it' to confirm, or anything else to cancel."

        fun normalize(s: String): String =
            s.lowercase()
                .replace(Regex("[^a-z0-9' ]"), " ")
                .replace(Regex("\\s+"), " ")
                .trim()

        fun isSendIt(transcript: String): Boolean = normalize(transcript) in ACCEPTED

        /** Identity of what the owner heard: kind, recipients, cc, subject, body and readback. */
        fun fingerprint(draft: Draft): String =
            listOf(draft.kind, draft.to.joinToString("\u001F"), draft.cc.joinToString("\u001F"), draft.subject, draft.body, draft.readback)
                .joinToString("\u001E")

        /** Only kinds this device knows how to read back may be approved by voice. */
        fun canApproveByVoice(draft: Draft): Boolean = draft.kind == DraftKind.EMAIL

        /** Read-back plus the instruction. */
        fun prompt(draft: Draft): String = "${readback(draft)} $CONFIRM_INSTRUCTION"

        /**
         * Recipient, subject and a one-sentence body summary, for speaking. Prefers the brain's
         * code-built `readback` (every address in full), then the body after an explicit
         * "Message begins:" marker so email text can't sound like part of the recipient line.
         * Older brains don't send `readback`; then recipients and subject come from the fields.
         */
        fun readback(draft: Draft): String {
            val brainReadback = draft.readback.trim()
            val parts = mutableListOf<String>()
            if (brainReadback.isNotEmpty()) {
                parts += stripTrailingPunctuation(brainReadback)
            } else {
                var first = "Email to ${spokenRecipients(draft.to)}"
                if (draft.cc.isNotEmpty()) first += ", copying ${spokenRecipients(draft.cc)}"
                parts += first
                val subject = draft.subject.trim()
                parts += "Subject: ${if (subject.isEmpty()) "no subject" else stripTrailingPunctuation(subject)}"
            }
            val summary = bodySummary(draft.body)
            val lead = if (brainReadback.isEmpty()) "It says" else "Message begins"
            parts += if (summary.isEmpty()) "The message is empty" else "$lead: ${stripTrailingPunctuation(summary)}"
            return parts.joinToString(". ") + "."
        }

        /** "Dana Smith <dana@acme.com>" -> "Dana Smith"; several -> "A, B and C". */
        fun spokenRecipients(list: List<String>): String {
            val names = list.map { raw ->
                val t = raw.trim()
                val lt = t.indexOf('<')
                if (lt >= 0) {
                    val name = t.substring(0, lt).trim(' ', '"', '\'')
                    if (name.isNotEmpty()) name else t.substring(lt + 1).trim('>', ' ')
                } else t
            }.filter { it.isNotEmpty() }
            return when (names.size) {
                0 -> "no recipient"
                1 -> names[0]
                else -> names.dropLast(1).joinToString(", ") + " and " + names.last()
            }
        }

        /**
         * First real sentence of the body: skips blank lines and a salutation line ("Hi Dana,"),
         * stops at the first ". ", "! " or "? ", and caps at [maxChars] on a word boundary.
         */
        fun bodySummary(body: String, maxChars: Int = 160): String {
            val lines = body.split("\r\n", "\n", "\r").map { it.trim() }.toMutableList()
            while (lines.isNotEmpty() && (lines[0].isEmpty() || isSalutation(lines[0]))) lines.removeAt(0)
            val text = lines.filter { it.isNotEmpty() }.joinToString(" ")
            if (text.isEmpty()) return ""
            var sentence = text
            for (i in text.indices) {
                if (text[i] in ".!?" && (i == text.length - 1 || text[i + 1] == ' ')) {
                    sentence = text.substring(0, i + 1)
                    break
                }
            }
            if (sentence.length > maxChars) {
                val cut = sentence.take(maxChars)
                val sp = cut.lastIndexOf(' ')
                sentence = (if (sp >= 0) cut.substring(0, sp) else cut) + "…"
            }
            return sentence
        }

        internal fun isSalutation(line: String): Boolean {
            val l = line.lowercase()
            if (line.length <= 40 && line.endsWith(",")) return true
            for (g in listOf("hi", "hello", "hey", "dear", "good morning", "good afternoon")) {
                if (l == g || l.startsWith("$g ") || l.startsWith("$g,")) return line.length <= 40
            }
            return false
        }

        private fun stripTrailingPunctuation(s: String): String = s.trim().trimEnd('.', '?', '!')
    }
}
