package com.sidekiqq.phone.assistant

import com.sidekiqq.shared.model.Action
import com.sidekiqq.shared.model.Draft

/**
 * What the voice pipeline says after `/api/ask` returns a `draft_created` action, and whether a
 * "send it" may then go to approve. Pure logic (mirrors the Swift kit's VoiceAssistant). Every
 * doubt ends in "approve it in the app": voice never arms on something the owner didn't hear.
 */
object DraftOffer {
    const val NOT_WAITING = "That draft is no longer waiting to be sent."
    const val APPROVE_IN_APP = "That draft is saved. Approve it in the app."
    const val CHANGED = "That draft changed since I read it to you, so I didn't send it. Check it in the app."
    const val CANT_CHECK = "I couldn't check the draft, so I didn't send it. It's still saved in the app."
    const val WINDOW_CLOSED = "The send window closed, so I didn't send it. The draft is saved in the app."

    /** What to speak, and which draft to arm once that has been fully heard (null = arm nothing). */
    data class OfferPlan(val speak: String, val arm: Draft?)

    /**
     * [pending] = GET /api/drafts items, or null if the fetch failed.
     *  - fetch failed: no read-back with the body is possible, so point at the app (Action carries
     *    no kind either, so it can't be checked).
     *  - draft not pending any more: say so (approve would only fail).
     *  - a kind this device can't read back: point at the app.
     *  - otherwise: brain readback + "Message begins:" body excerpt + the instruction, then arm.
     */
    fun plan(action: Action, pending: List<Draft>?): OfferPlan {
        if (pending == null) return OfferPlan(APPROVE_IN_APP, null)
        val draft = pending.firstOrNull { it.id == action.id } ?: return OfferPlan(NOT_WAITING, null)
        if (!DraftConfirmation.canApproveByVoice(draft)) return OfferPlan(APPROVE_IN_APP, null)
        return OfferPlan(DraftConfirmation.prompt(draft), draft)
    }

    /**
     * Right before approve: the draft must still be pending and unchanged since the read-back.
     * Returns null when approve may go ahead, else the sentence to speak instead.
     * (The brain's 409 `changed_in_provider` only covers To/Cc/Bcc/Subject, not the body.)
     */
    fun checkBeforeApprove(confirmed: DraftConfirmation.Decision.Confirmed, pending: List<Draft>?): String? {
        if (pending == null) return CANT_CHECK
        val draft = pending.firstOrNull { it.id == confirmed.draftId } ?: return NOT_WAITING
        if (DraftConfirmation.fingerprint(draft) != confirmed.fingerprint) return CHANGED
        return null
    }
}
