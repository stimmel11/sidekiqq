package com.sidekiqq.watch.logic

/**
 * Two-step approval for sending a drafted message. The only transition that may call
 * SideKiqqClient.approveDraft is Confirming -> Sending, and it is reached only by an explicit
 * Approve tap followed by an explicit "Send to <person>?" confirm tap.
 *
 * Pure reducer: every function returns the next state and whether the caller should send now.
 */
sealed interface ApproveState {
    /** Showing the suggested message with an Approve button. */
    data object Reviewing : ApproveState

    /** Showing "Send to <person>?" with Send / Cancel. */
    data object Confirming : ApproveState

    /** The approve call is in flight. Buttons are disabled. */
    data object Sending : ApproveState

    data object Sent : ApproveState

    data class Failed(val message: String) : ApproveState
}

data class ApproveStep(val state: ApproveState, val sendNow: Boolean = false)

object ApproveFlow {

    val initial: ApproveState = ApproveState.Reviewing

    /** First tap. Never sends. */
    fun onApproveTapped(state: ApproveState): ApproveStep = when (state) {
        ApproveState.Reviewing, is ApproveState.Failed -> ApproveStep(ApproveState.Confirming)
        else -> ApproveStep(state)
    }

    /** Second tap. Sends only from Confirming, so double taps can't send twice. */
    fun onConfirmTapped(state: ApproveState): ApproveStep = when (state) {
        ApproveState.Confirming -> ApproveStep(ApproveState.Sending, sendNow = true)
        else -> ApproveStep(state)
    }

    fun onCancel(state: ApproveState): ApproveStep = when (state) {
        ApproveState.Confirming, is ApproveState.Failed -> ApproveStep(ApproveState.Reviewing)
        else -> ApproveStep(state)
    }

    fun onResult(state: ApproveState, error: String?): ApproveStep = when (state) {
        ApproveState.Sending ->
            if (error == null) ApproveStep(ApproveState.Sent) else ApproveStep(ApproveState.Failed(error))
        else -> ApproveStep(state)
    }

    /** The confirm question, e.g. "Send to Dana?". */
    fun confirmPrompt(person: String): String {
        val name = person.trim().ifEmpty { "this person" }
        return "Send to $name?"
    }
}
