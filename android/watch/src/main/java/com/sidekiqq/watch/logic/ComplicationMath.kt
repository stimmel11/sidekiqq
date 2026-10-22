package com.sidekiqq.watch.logic

/** Text and gauge values for the follow-ups complication. */
object ComplicationMath {
    /** Gauge is full at this many follow-ups. */
    const val RANGE_MAX = 10f

    /** SHORT_TEXT should be about 3 characters or fewer. */
    fun shortText(count: Int): String = when {
        count < 0 -> "--"
        count > 99 -> "99+"
        else -> count.toString()
    }

    fun rangedValue(count: Int): Float = count.coerceIn(0, RANGE_MAX.toInt()).toFloat()

    fun contentDescription(count: Int): String = when (count) {
        0 -> "No follow-ups needed"
        1 -> "1 follow-up needed"
        else -> "$count follow-ups needed"
    }
}
