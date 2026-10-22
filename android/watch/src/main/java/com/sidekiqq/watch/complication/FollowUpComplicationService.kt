package com.sidekiqq.watch.complication

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationText
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import com.sidekiqq.watch.R
import com.sidekiqq.watch.app
import com.sidekiqq.watch.logic.ComplicationMath
import com.sidekiqq.watch.ui.MainActivity
import com.sidekiqq.watch.ui.Routes
import kotlinx.coroutines.withTimeoutOrNull

/**
 * SHORT_TEXT: the number of follow-ups needed, e.g. "4", titled "F/U".
 * RANGED_VALUE: the same count as a gauge from 0 to 10.
 * Tapping opens the Follow-ups screen.
 *
 * Updates come from the manifest UPDATE_PERIOD_SECONDS (1800) and from GlanceRefreshWorker.
 */
class FollowUpComplicationService : SuspendingComplicationDataSourceService() {

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
        val repo = applicationContext.app.repository
        val count = if (repo.isPaired) {
            withTimeoutOrNull(5_000L) { runCatching { repo.followUps().size }.getOrNull() }
                ?: repo.cachedGlance().followUpCount
        } else {
            -1
        }
        return build(request.complicationType, count)
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? = build(type, 3, tap = false)

    private fun build(type: ComplicationType, count: Int, tap: Boolean = true): ComplicationData? {
        val desc = plain(if (count < 0) "SideKiqq not paired" else ComplicationMath.contentDescription(count))
        val icon = MonochromaticImage.Builder(Icon.createWithResource(this, R.drawable.ic_sidekiqq)).build()
        val tapIntent = if (tap) openFollowUps() else null
        return when (type) {
            ComplicationType.SHORT_TEXT ->
                ShortTextComplicationData.Builder(plain(ComplicationMath.shortText(count)), desc)
                    .setTitle(plain("F/U"))
                    .setMonochromaticImage(icon)
                    .setTapAction(tapIntent)
                    .build()

            ComplicationType.RANGED_VALUE ->
                // Builder(value, min, max, contentDescription)
                RangedValueComplicationData.Builder(
                    ComplicationMath.rangedValue(count),
                    0f,
                    ComplicationMath.RANGE_MAX,
                    desc,
                )
                    .setText(plain(ComplicationMath.shortText(count)))
                    .setMonochromaticImage(icon)
                    .setTapAction(tapIntent)
                    .build()

            else -> null
        }
    }

    private fun plain(s: String): ComplicationText = PlainComplicationText.Builder(s).build()

    private fun openFollowUps(): PendingIntent = PendingIntent.getActivity(
        this, 2001,
        Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_ROUTE, Routes.FOLLOWUPS),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}
