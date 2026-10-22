package com.sidekiqq.watch.wearable

import android.util.Log
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import com.sidekiqq.shared.wear.WearProtocol
import com.sidekiqq.watch.app
import com.sidekiqq.watch.logic.Payloads
import com.sidekiqq.watch.tile.GlanceRefreshWorker

/**
 * Receives from the phone companion:
 *  - /sidekiqq/alert (message): notification, plus the distinct haptic for CRITICAL
 *  - /sidekiqq/reply (message): medallion answer, as a notification and the reply screen
 *  - /sidekiqq/config (DataItem, WearProtocol.PATH_CONFIG): device token and baseUrl. This is the
 *    phone bot's name for what the brief called "/sidekiqq/token"; both paths are accepted.
 *
 * Paths and payload classes come from :shared WearProtocol, which the phone also uses.
 * Bound by Google Play services through the manifest intent filters, which must stay in sync
 * with [PATH_ALERT] and the others. Callbacks run on a background thread.
 */
class PhoneListenerService : WearableListenerService() {

    override fun onMessageReceived(event: MessageEvent) {
        when (event.path) {
            PATH_ALERT -> Payloads.parseAlert(event.data)?.let { app.notifier.showAlert(it) }
                ?: Log.w(TAG, "Malformed alert payload")

            PATH_REPLY -> Payloads.parseReply(event.data)?.let { reply ->
                reply.conversationId?.let { app.prefs.conversationId = it }
                app.replyBus.publish(reply)
                app.notifier.showReply(reply)
            } ?: Log.w(TAG, "Malformed reply payload")

            else -> Log.d(TAG, "Ignoring message on ${event.path}")
        }
    }

    override fun onDataChanged(events: DataEventBuffer) {
        // DataEventBuffer is only valid during this callback; read everything before returning.
        events.forEach { e ->
            val path = e.dataItem.uri.path
            if (path !in CONFIG_PATHS) return@forEach
            if (e.type == DataEvent.TYPE_CHANGED) {
                val map = DataMapItem.fromDataItem(e.dataItem).dataMap
                val token = map.getString(KEY_TOKEN)
                if (!token.isNullOrBlank()) saveToken(token, map.getString(KEY_BASE_URL))
            } else if (e.type == DataEvent.TYPE_DELETED) {
                // The phone unpaired. Drop our copy so we stop calling the brain with a revoked token.
                app.prefs.token = null
            }
        }
    }

    private fun saveToken(token: String, baseUrl: String?) {
        val prefs = app.prefs
        if (!baseUrl.isNullOrBlank()) prefs.baseUrl = baseUrl
        if (prefs.token == token) return
        prefs.token = token
        Log.i(TAG, "Device token received from phone")
        GlanceRefreshWorker.refreshNow(applicationContext)
    }

    companion object {
        private const val TAG = "SideKiqqListener"
        const val PATH_ALERT = WearProtocol.PATH_ALERT
        const val PATH_REPLY = WearProtocol.PATH_REPLY
        const val PATH_CONFIG = WearProtocol.PATH_CONFIG

        /** Legacy name from the watch brief. Accepted in case anything still publishes there. */
        const val PATH_TOKEN_LEGACY = "/sidekiqq/token"
        val CONFIG_PATHS = setOf(PATH_CONFIG, PATH_TOKEN_LEGACY)
        const val KEY_TOKEN = WearProtocol.KEY_TOKEN
        const val KEY_BASE_URL = WearProtocol.KEY_BASE_URL
    }
}
