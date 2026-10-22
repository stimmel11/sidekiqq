package com.sidekiqq.watch.ui

object Routes {
    const val ASK = "ask"
    const val TOP5 = "top5"
    const val FOLLOWUPS = "followups"
    const val FOLLOWUP_DETAIL = "followup/{id}"
    const val COMMITMENTS = "commitments"
    const val REPLY = "reply"
    const val SETTINGS = "settings"

    fun followUpDetail(id: String) = "followup/${android.net.Uri.encode(id)}"

    /** Routes that can be opened from outside the app (notification, tile, complication). */
    val external = setOf(ASK, TOP5, FOLLOWUPS, COMMITMENTS, REPLY)
}
