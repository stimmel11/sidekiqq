package com.sidekiqq.watch.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.sidekiqq.shared.model.Importance
import com.sidekiqq.watch.R
import com.sidekiqq.watch.logic.AlertPayload
import com.sidekiqq.watch.logic.HapticPatterns
import com.sidekiqq.watch.logic.ReplyPayload
import com.sidekiqq.watch.ui.MainActivity
import com.sidekiqq.watch.ui.Routes

class Notifier(private val context: Context) {

    private val nm = NotificationManagerCompat.from(context)

    fun ensureChannels() {
        val sys = context.getSystemService(NotificationManager::class.java) ?: return
        fun channel(id: String, nameRes: Int, importance: Int, pattern: LongArray?) =
            NotificationChannel(id, context.getString(nameRes), importance).apply {
                if (pattern == null) {
                    enableVibration(false)
                } else {
                    enableVibration(true)
                    vibrationPattern = pattern
                }
            }
        sys.createNotificationChannels(
            listOf(
                // CRITICAL uses the long triple pulse as the channel pattern too, so it is
                // distinctive even if the explicit Haptics.play call is suppressed.
                channel(CH_CRITICAL, R.string.channel_critical, NotificationManager.IMPORTANCE_HIGH, HapticPatterns.CRITICAL.timings),
                channel(CH_HIGH, R.string.channel_high, NotificationManager.IMPORTANCE_HIGH, HapticPatterns.HIGH.timings),
                channel(CH_NORMAL, R.string.channel_normal, NotificationManager.IMPORTANCE_DEFAULT, HapticPatterns.MEDIUM.timings),
                channel(CH_LOW, R.string.channel_low, NotificationManager.IMPORTANCE_LOW, null),
                channel(CH_REPLY, R.string.channel_reply, NotificationManager.IMPORTANCE_HIGH, HapticPatterns.REPLY.timings),
            ),
        )
    }

    private fun canPost(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun channelFor(importance: Importance): String = when (importance) {
        Importance.CRITICAL -> CH_CRITICAL
        Importance.HIGH -> CH_HIGH
        Importance.MEDIUM -> CH_NORMAL
        Importance.LOW, Importance.FYI -> CH_LOW
    }

    fun showAlert(alert: AlertPayload) {
        val critical = alert.importance == Importance.CRITICAL
        // Distinct haptic for CRITICAL, played even if notifications are blocked.
        if (critical) Haptics.play(context, HapticPatterns.CRITICAL, urgent = true)
        if (!canPost()) return

        val n = NotificationCompat.Builder(context, channelFor(alert.importance))
            .setSmallIcon(R.drawable.ic_sidekiqq)
            .setContentTitle(if (critical) "CRITICAL: ${alert.title}" else alert.title)
            .setContentText(alert.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(alert.body))
            .setPriority(if (critical) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(if (critical) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(openIntent(alert.route ?: Routes.ASK, alert.id.hashCode()))
            .setAutoCancel(true)
            .build()
        @Suppress("MissingPermission") // checked in canPost()
        nm.notify(TAG_ALERT, alert.id.hashCode(), n)
    }

    /**
     * Medallion replies always post a notification; that is the reliable way to surface them
     * while the app is in the background, since background activity starts are blocked. If the
     * app is in the foreground, MainActivity also navigates straight to the reply screen via
     * ReplyBus.
     */
    fun showReply(reply: ReplyPayload) {
        if (!canPost()) return
        val n = NotificationCompat.Builder(context, CH_REPLY)
            .setSmallIcon(R.drawable.ic_sidekiqq)
            .setContentTitle(reply.source?.let { "SideKiqq · $it" } ?: "SideKiqq")
            .setContentText(reply.spoken)
            .setStyle(NotificationCompat.BigTextStyle().bigText(reply.reply))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(openIntent(Routes.REPLY, REPLY_ID))
            .setAutoCancel(true)
            .build()
        @Suppress("MissingPermission")
        nm.notify(TAG_REPLY, REPLY_ID, n)
    }

    fun cancelReply() = nm.cancel(TAG_REPLY, REPLY_ID)

    private fun openIntent(route: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_ROUTE, route)
        return PendingIntent.getActivity(
            context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        const val CH_CRITICAL = "sidekiqq_critical_v1"
        const val CH_HIGH = "sidekiqq_high_v1"
        const val CH_NORMAL = "sidekiqq_normal_v1"
        const val CH_LOW = "sidekiqq_low_v1"
        const val CH_REPLY = "sidekiqq_reply_v1"
        private const val TAG_ALERT = "alert"
        private const val TAG_REPLY = "reply"
        private const val REPLY_ID = 1001
    }
}
