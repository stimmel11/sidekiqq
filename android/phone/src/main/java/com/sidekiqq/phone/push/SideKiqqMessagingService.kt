package com.sidekiqq.phone.push

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.sidekiqq.phone.MainActivity
import com.sidekiqq.phone.R
import com.sidekiqq.phone.SideKiqqApp
import com.sidekiqq.phone.medallion.MedallionService
import com.sidekiqq.phone.sideKiqqApp
import com.sidekiqq.shared.model.Device
import com.sidekiqq.shared.model.Importance
import com.sidekiqq.shared.wear.WearAlert
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * Receives proactive alerts from the brain (/api/cron/scan -> FCM).
 *
 * Expected data payload keys (assumption, shared with the backend bot):
 *   title, body, importance (CRITICAL|HIGH|MEDIUM|LOW|FYI), kind, followUpId?, draftId?
 * A plain `notification` payload is also handled.
 *
 * For each alert: post a phone notification, forward it to the watch (Data Layer "/sidekiqq/alert"),
 * and buzz the medallion (CONTROL 0x12) when importance is HIGH or CRITICAL.
 * Notifications open the app; they never carry a "send" action. Drafts are approved in-app behind a confirm dialog.
 */
class SideKiqqMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        registerToken(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val d = message.data
        val title = d["title"] ?: message.notification?.title ?: "SideKiqq"
        val body = d["body"] ?: message.notification?.body ?: return
        val importance = d["importance"]?.let { runCatching { Importance.valueOf(it.uppercase()) }.getOrNull() }
            ?: Importance.MEDIUM
        val alert = WearAlert(
            title = title,
            body = body,
            importance = importance,
            kind = d["kind"],
            followUpId = d["followUpId"],
            draftId = d["draftId"],
        )
        if (importance == Importance.FYI) {
            Log.d(TAG, "FYI alert; no notification: $title")
            return
        }

        showNotification(this, alert)

        val app = sideKiqqApp
        app.appScope.launch { app.wearRelay.sendAlert(alert) }

        if (importance == Importance.CRITICAL || importance == Importance.HIGH) {
            MedallionService.signalNeedsAttention()
        }
    }

    companion object {
        private const val TAG = "SideKiqqFcm"

        /** Fetches the current FCM token and registers it with the brain. Safe to call repeatedly. */
        fun refreshRegistration(context: Context) {
            val app = context.sideKiqqApp
            app.appScope.launch {
                val token = try {
                    FirebaseMessaging.getInstance().token.await()
                } catch (e: Exception) {
                    // Firebase not configured (no google-services.json) or Play services missing.
                    Log.w(TAG, "FCM unavailable: ${e.message}")
                    return@launch
                }
                registerToken(context, token)
            }
        }

        private fun registerToken(context: Context, token: String) {
            val app = context.sideKiqqApp
            app.appScope.launch {
                val client = app.client() ?: return@launch
                if (app.tokenStore.token() == null) return@launch
                runCatching { client.registerDevice(token, Device.PHONE) }
                    .onFailure { Log.w(TAG, "registerDevice failed", it) }
            }
        }

        fun showNotification(context: Context, alert: WearAlert) {
            val open = PendingIntent.getActivity(
                context,
                alert.hashCode(),
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(MainActivity.EXTRA_OPEN_TAB, if (alert.followUpId != null) "followups" else "home"),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val n = Notification.Builder(context, SideKiqqApp.CHANNEL_ALERTS)
                .setSmallIcon(R.drawable.ic_stat_sidekiqq)
                .setContentTitle(alert.title)
                .setContentText(alert.body)
                .setStyle(Notification.BigTextStyle().bigText(alert.body))
                .setSubText(alert.importance.name)
                .setAutoCancel(true)
                .setContentIntent(open)
                .setCategory(Notification.CATEGORY_REMINDER)
                .build()
            val nm = context.getSystemService(NotificationManager::class.java)
            if (nm.areNotificationsEnabled()) {
                nm.notify((alert.followUpId ?: alert.title).hashCode(), n)
            }
        }
    }
}
