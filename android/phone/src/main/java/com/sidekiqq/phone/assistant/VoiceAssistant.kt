package com.sidekiqq.phone.assistant

import android.util.Log
import com.sidekiqq.phone.wear.WearRelay
import com.sidekiqq.shared.SideKiqqClient
import com.sidekiqq.shared.audio.WavEncoder
import com.sidekiqq.shared.model.Action
import com.sidekiqq.shared.model.ActionType
import com.sidekiqq.shared.model.AskResponse
import com.sidekiqq.shared.model.Device
import com.sidekiqq.shared.wear.WearReply
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Where a voice turn's audio output goes (glasses speaker, earbuds, phone). */
fun interface VoiceOutput {
    suspend fun speak(text: String)
}

/**
 * The voice pipeline shared by the medallion relay and the glasses session:
 *   PCM -> WAV -> /api/transcribe -> (pending draft confirmation?) -> /api/ask -> speak `spoken`
 *   -> mirror the reply on the watch.
 *
 * Nothing is ever sent without the strict "send it" confirmation in [DraftConfirmation].
 */
class VoiceAssistant(
    private val clientProvider: () -> SideKiqqClient?,
    private val wear: WearRelay,
    private val confirmation: DraftConfirmation = DraftConfirmation(),
    private val now: () -> Long = System::currentTimeMillis,
) {
    sealed interface Outcome {
        /** The assistant answered. [awaitingConfirm] = a draft is waiting for "send it". */
        data class Answered(val transcript: String, val response: AskResponse, val awaitingConfirm: Boolean) : Outcome
        data class DraftSent(val draftId: String) : Outcome
        data object DraftNotSent : Outcome
        data object NothingHeard : Outcome
        data object NotPaired : Outcome
        data class Failed(val error: Throwable) : Outcome
    }

    private val lock = Mutex()
    private val conversations = HashMap<Device, Pair<String, Long>>()

    val isAwaitingConfirm: Boolean get() = confirmation.pending != null

    suspend fun handleUtterance(pcm: ByteArray, device: Device, output: VoiceOutput): Outcome {
        if (WavEncoder.durationMs(pcm.size) < MIN_UTTERANCE_MS) return Outcome.NothingHeard
        val client = clientProvider() ?: return Outcome.NotPaired.also { output.speak(NOT_PAIRED) }
        val text = try {
            client.transcribe(WavEncoder.encode(pcm)).trim()
        } catch (e: Exception) {
            Log.w(TAG, "transcribe failed", e)
            output.speak(TROUBLE)
            return Outcome.Failed(e)
        }
        if (text.isEmpty()) {
            if (confirmation.pending != null) {
                confirmation.clear()
                output.speak(NOT_SENT)
                return Outcome.DraftNotSent
            }
            output.speak("Sorry, I didn't catch that.")
            return Outcome.NothingHeard
        }
        return handleText(text, device, output)
    }

    suspend fun handleText(text: String, device: Device, output: VoiceOutput): Outcome = lock.withLock {
        val client = clientProvider() ?: return@withLock Outcome.NotPaired.also { output.speak(NOT_PAIRED) }

        // 1) A draft is waiting for confirmation: this utterance is the answer, nothing else.
        when (val d = confirmation.evaluate(text)) {
            is DraftConfirmation.Decision.Confirmed -> {
                return@withLock try {
                    client.approveDraft(d.draftId)
                    output.speak("Sent.")
                    Outcome.DraftSent(d.draftId)
                } catch (e: Exception) {
                    Log.w(TAG, "approveDraft failed", e)
                    output.speak("I couldn't send it. The draft is still saved in the app.")
                    Outcome.Failed(e)
                }
            }
            DraftConfirmation.Decision.Declined -> {
                output.speak(NOT_SENT)
                return@withLock Outcome.DraftNotSent
            }
            // The confirm window lapsed: the draft simply stays unsent, and this utterance is a new question.
            DraftConfirmation.Decision.Expired, DraftConfirmation.Decision.NothingPending -> Unit
        }

        // 2) Normal question.
        val response = try {
            client.ask(text, device, conversationIdFor(device))
        } catch (e: Exception) {
            Log.w(TAG, "ask failed", e)
            output.speak(TROUBLE)
            return@withLock Outcome.Failed(e)
        }
        conversations[device] = response.conversationId to now()

        wear.sendReply(
            WearReply(
                text = response.reply,
                spoken = response.spoken,
                conversationId = response.conversationId,
                source = device.wire,
                actions = response.actions,
            )
        )

        output.speak(response.spoken.ifBlank { response.reply })

        val drafts = response.actions.filter { it.type == ActionType.DRAFT_CREATED }
        val awaiting = drafts.firstOrNull()?.let { offerDraft(it, drafts.size, output) } ?: false
        Outcome.Answered(text, response, awaiting)
    }

    private suspend fun offerDraft(draft: Action, total: Int, output: VoiceOutput): Boolean {
        output.speak(confirmation.offer(draft.id, draft.summary))
        if (total > 1) Log.i(TAG, "${total - 1} more draft(s) only approvable in the app/watch")
        return true
    }

    private fun conversationIdFor(device: Device): String? {
        val (id, at) = conversations[device] ?: return null
        return if (now() - at < CONVERSATION_IDLE_MS) id else null
    }

    fun cancelPendingDraft() = confirmation.clear()

    companion object {
        private const val TAG = "SideKiqqVoice"
        const val MIN_UTTERANCE_MS = 300L
        const val CONVERSATION_IDLE_MS = 5 * 60_000L
        const val NOT_SENT = "Okay, not sent. The draft is saved."
        const val TROUBLE = "Sorry, I'm having trouble reaching SideKiqq."
        const val NOT_PAIRED = "SideKiqq isn't paired yet. Open the app on your phone to pair."
    }
}
