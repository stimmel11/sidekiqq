package com.sidekiqq.phone.wear

import android.content.Context
import android.util.Log
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.PutDataRequest
import com.google.android.gms.wearable.Wearable
import com.sidekiqq.shared.wear.WearAlert
import com.sidekiqq.shared.wear.WearProtocol
import com.sidekiqq.shared.wear.WearReply
import kotlinx.coroutines.tasks.await

/**
 * Phone -> Galaxy Watch over the Wearable Data Layer. Paths and payloads live in
 * com.sidekiqq.shared.wear.WearProtocol so the watch app uses the identical contract.
 * Every call is best-effort: a missing watch is not an error.
 */
class WearRelay(context: Context) {
    private val appContext = context.applicationContext
    private val nodes by lazy { Wearable.getNodeClient(appContext) }
    private val messages by lazy { Wearable.getMessageClient(appContext) }
    private val data by lazy { Wearable.getDataClient(appContext) }

    suspend fun sendAlert(alert: WearAlert) = broadcast(WearProtocol.PATH_ALERT, WearProtocol.encode(alert))

    suspend fun sendReply(reply: WearReply) = broadcast(WearProtocol.PATH_REPLY, WearProtocol.encode(reply))

    /** Shares the server URL + device token so the watch can call the brain directly. */
    suspend fun pushConfig(baseUrl: String, token: String) {
        try {
            val req = PutDataMapRequest.create(WearProtocol.PATH_CONFIG).apply {
                dataMap.putString(WearProtocol.KEY_BASE_URL, baseUrl)
                dataMap.putString(WearProtocol.KEY_TOKEN, token)
                dataMap.putLong("updatedAt", System.currentTimeMillis())
            }.asPutDataRequest().setUrgent()
            data.putDataItem(req).await()
        } catch (e: Exception) {
            Log.w(TAG, "pushConfig failed (no watch / no Play services?)", e)
        }
    }

    /** Removes the config DataItem (on unpair). */
    suspend fun clearConfig() {
        try {
            // DataItems are keyed by the node that wrote them: wear://<localNodeId>/sidekiqq/config
            val local = nodes.localNode.await().id
            val uri = android.net.Uri.Builder()
                .scheme(PutDataRequest.WEAR_URI_SCHEME).authority(local).path(WearProtocol.PATH_CONFIG).build()
            data.deleteDataItems(uri).await()
        } catch (e: Exception) {
            Log.w(TAG, "clearConfig failed", e)
        }
    }

    /** @return number of watches the message was delivered to the transport for. */
    private suspend fun broadcast(path: String, payload: ByteArray): Int = try {
        val connected = nodes.connectedNodes.await()
        var sent = 0
        for (node in connected) {
            try {
                messages.sendMessage(node.id, path, payload).await()
                sent++
            } catch (e: Exception) {
                Log.w(TAG, "sendMessage $path to ${node.displayName} failed", e)
            }
        }
        sent
    } catch (e: Exception) {
        Log.w(TAG, "Wearable API unavailable", e)
        0
    }

    private companion object { const val TAG = "SideKiqqWear" }
}
