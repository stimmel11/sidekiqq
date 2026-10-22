package com.sidekiqq.watch.logic

import com.sidekiqq.shared.model.CommitmentStatus
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * Due-date parsing and wording for commitments and top items. Pure (clock and zone are passed in)
 * so it can be unit tested.
 *
 * Inferred dates always carry a visible "inferred" marker. The EA operating rules require that an
 * inferred date is never shown as if it were confirmed.
 */
object DueFormat {

    const val INFERRED_SUFFIX = " · inferred"

    /**
     * Accepts ISO-8601 instants ("2026-10-16T17:00:00Z"), offset date-times
     * ("2026-10-16T11:00:00-06:00") and bare dates ("2026-10-16"). A bare date counts as due at the
     * end of that day in [zone]. Returns null for null, blank or unparseable input.
     */
    fun parse(iso: String?, zone: ZoneId): Instant? {
        if (iso.isNullOrBlank()) return null
        val s = iso.trim()
        return try {
            OffsetDateTime.parse(s).toInstant()
        } catch (_: DateTimeParseException) {
            try {
                Instant.parse(s)
            } catch (_: DateTimeParseException) {
                try {
                    LocalDate.parse(s).plusDays(1).atStartOfDay(zone).toInstant().minusSeconds(1)
                } catch (_: DateTimeParseException) {
                    null
                }
            }
        }
    }

    /** The server's status wins. An OPEN item whose due time has passed also counts as overdue. */
    fun isOverdue(status: CommitmentStatus, due: Instant?, now: Instant): Boolean = when (status) {
        CommitmentStatus.OVERDUE -> true
        CommitmentStatus.OPEN -> due != null && due.isBefore(now)
        else -> false
    }

    /**
     * Short label that fits on a watch chip:
     *   "Overdue 3d", "Overdue 5h", "Overdue", "Due in 40m", "Due today", "Due tomorrow",
     *   "Due in 4d", "Due Oct 30", "No due date". " · inferred" is appended when [inferred].
     */
    fun label(
        due: Instant?,
        inferred: Boolean,
        now: Instant,
        zone: ZoneId,
        overdue: Boolean = due != null && due.isBefore(now),
        locale: Locale = Locale.US,
    ): String {
        val base = when {
            due == null && overdue -> "Overdue"
            due == null -> "No due date"
            overdue -> overdueLabel(Duration.between(due, now))
            else -> upcomingLabel(due, now, zone, locale)
        }
        // A missing date can't be inferred, so only mark real dates.
        return if (inferred && due != null) base + INFERRED_SUFFIX else base
    }

    private fun overdueLabel(late: Duration): String {
        val days = late.toDays()
        val hours = late.toHours()
        return when {
            days >= 1 -> "Overdue ${days}d"
            hours >= 1 -> "Overdue ${hours}h"
            else -> "Overdue"
        }
    }

    private fun upcomingLabel(due: Instant, now: Instant, zone: ZoneId, locale: Locale): String {
        val until = Duration.between(now, due)
        val dueDay = due.atZone(zone).toLocalDate()
        val today = now.atZone(zone).toLocalDate()
        val dayDiff = ChronoUnit.DAYS.between(today, dueDay)
        return when {
            until.toMinutes() < 60 -> "Due in ${until.toMinutes().coerceAtLeast(1)}m"
            dayDiff == 0L -> "Due today"
            dayDiff == 1L -> "Due tomorrow"
            dayDiff in 2..6 -> "Due in ${dayDiff}d"
            else -> "Due " + DateTimeFormatter.ofPattern("MMM d", locale).format(dueDay)
        }
    }
}
