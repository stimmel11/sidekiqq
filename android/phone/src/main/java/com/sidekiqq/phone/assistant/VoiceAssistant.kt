package com.sidekiqq.phone.assistant

import android.os.SystemClock
import android.util.Log
import com.sidekiqq.phone.wear.WearRelay
import com.sidekiqq.shared.SideKiqqClient
import com.sidekiqq.shared.audio.WavEncoder
import com.sidekiqq.shared.model.Action
import com.sidekiqq.shared.model.ActionType
import com.sidekiqq.shared.model.AskResponse
import com.sidekiqq.shared.model.Device
import com.sidekiqq.shared.model.Draft
import com.sidekiqq.shared.wear.WearReply
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Where a voice turn's audio output goes (glasses speaker, earbuds, phone). */
fun interface VoiceOutput {
    /** Returns true only if [text] played to the end (not skipped, failed, interrupted or timed out). */
    suspend fun speak(text: String): Boolean
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
    /** Monotonic clock shared by the confirmation window and the callers' `startedAt`. */
    private val now: () -> Long = SystemClock::elapsedRealtime,
    private val confirmation: DraftConfirmation = DraftConfirmation(now = now),
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

    /**
     * @param startedAt when capture of this utterance began, on `SystemClock.elapsedRealtime()`
     *   (medallion CONTROL start / first packet, or just before the glasses `listen()`). Speech that
     *   began before a draft's confirmation window opened can't confirm it.
     */
    suspend fun handleUtterance(pcm: ByteArray, device: Device, output: VoiceOutput, startedAt: Long): Outcome {
        if (WavEncoder.durationMs(pcm.size) < MIN_UTTERANCE_MS) return Outcome.NothingHeard
        val client = clientProvider() ?: return Outcome.NotPaired.also { output.speak(NOT_PAIRED) }
        val text = try {
            client.transcribe(WavEncoder.encode(pcm)).trim()
        } catch (e: CancellationException) {
            throw e
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
        return handleText(text, device, output, startedAt)
    }

    /**
     * @param spokenAt when the owner started saying [text] (same clock as `now`). Null = unknown
     *   (typed text): it can never confirm a pending draft.
     */
    internal suspend fun handleText(text: String, device: Device, output: VoiceOutput, spokenAt: Long? = null): Outcome = lock.withLock {
        val client = clientProvider() ?: return@withLock Outcome.NotPaired.also { output.speak(NOT_PAIRED) }

        // 1) A draft is waiting for confirmation: this utterance is the answer, nothing else.
        when (val d = confirmation.evaluate(text, spokenAt)) {
            is DraftConfirmation.Decision.Confirmed -> {
                // Still pending and exactly what was read back? Otherwise nothing is sent.
                DraftOffer.checkBeforeApprove(d, fetchPending(client))?.let { refusal ->
                    output.speak(refusal)
                    return@withLock Outcome.DraftNotSent
                }
                return@withLock try {
                    client.approveDraft(d.draftId)
                    output.speak("Sent.")
                    Outcome.DraftSent(d.draftId)
                } catch (e: CancellationException) {
                    throw e
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
            // The confirm window lapsed: the draft stays unsent. A late "send it" is told so;
            // anything else is a new question.
            DraftConfirmation.Decision.Expired -> if (DraftConfirmation.isSendIt(text)) {
                output.speak(DraftOffer.WINDOW_CLOSED)
                return@withLock Outcome.DraftNotSent
            }
            DraftConfirmation.Decision.NothingPending -> Unit
        }

        // 2) Normal question.
        val response = try {
            client.ask(text, device, conversationIdFor(device))
        } catch (e: CancellationException) {
            throw e
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
        val awaiting = drafts.firstOrNull()?.let { offerDraft(client, it, drafts.size, output) } ?: false
        Outcome.Answered(text, response, awaiting)
    }

    /**
     * Reads the draft back from GET /api/drafts (brain readback + "Message begins:" body excerpt)
     * and arms the "send it" window only once that read-back has played to the end. Returns true
     * when a confirmation is armed. See [DraftOffer.plan].
     */
    private suspend fun offerDraft(client: SideKiqqClient, action: Action, total: Int, output: VoiceOutput): Boolean {
        val plan = DraftOffer.plan(action, fetchPending(client))
        val heard = output.speak(plan.speak)
        if (total > 1) Log.i(TAG, "${total - 1} more draft(s) only approvable in the app/watch")
        val draft = plan.arm ?: return false
        if (!heard) {
            // Interrupted (barge-in), TTS not ready, failed or timed out: never open a window the
            // owner didn't fully hear the read-back for. Don't talk over a barge-in; the draft
            // stays pending in the app.
            Log.i(TAG, "read-back not fully played; draft ${draft.id} left for the app")
            return false
        }
        confirmation.arm(draft)
        return true
    }

    private suspend fun fetchPending(client: SideKiqqClient): List<Draft>? = try {
        client.pendingDrafts()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Log.w(TAG, "pendingDrafts failed", e)
        null
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
