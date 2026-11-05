package com.sidekiqq.phone.handoff

/**
 * What the phone does with an FCM data message, decided before any alert handling. Pure Kotlin
 * (no android.*) so it is unit-tested on the JVM.
 *
 * The brain sends `{ kind: "command", commandId }` (no title/body) to the target device right
 * after POST /api/commands queues a hand-off (ARCHITECTURE.md › Device commands). The nudge is only
 * a hint to poll: the command, its label and its number/URL are read ONLY from the authenticated
 * GET /api/commands, and nothing opens until the owner taps. A nudge is never shown as an alert,
 * forwarded to the watch, or turned into a medallion haptic.
 */
sealed interface NudgeAction {
    /** Not a command nudge: handle as a normal alert. */
    data object NotANudge : NudgeAction

    /** App is on screen: poll GET /api/commands now. */
    data object PollNow : NudgeAction

    /** App is in the background: post one generic, content-free "hand-off waiting" notification. */
    data object NotifyWaiting : NudgeAction

    /** A command nudge we can't use (not paired, malformed): drop it silently. */
    data object Ignore : NudgeAction
}

object CommandNudge {
    const val KIND = "command"

    /** Same shape as the brain's ids (`newId("cmd")`): short, URL-safe. Anything else is ignored. */
    private val COMMAND_ID = Regex("[A-Za-z0-9_-]{1,64}")

    fun isNudge(data: Map<String, String>): Boolean = data["kind"] == KIND

    fun decide(data: Map<String, String>, paired: Boolean, appVisible: Boolean): NudgeAction {
        if (!isNudge(data)) return NudgeAction.NotANudge
        val id = data["commandId"]
        if (!paired || id == null || !COMMAND_ID.matches(id)) return NudgeAction.Ignore
        return if (appVisible) NudgeAction.PollNow else NudgeAction.NotifyWaiting
    }
}
