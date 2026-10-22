package com.sidekiqq.watch.wearable

import android.content.Context
import android.net.Uri
import android.util.Log
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.PutDataRequest
import com.google.android.gms.wearable.Wearable
import com.sidekiqq.watch.app
import kotlinx.coroutines.tasks.await

/**
 * Catches a token the phone published before this app was installed or first launched, when no
 * onDataChanged will fire. Call on launch while unpaired.
 */
object TokenSync {
    suspend fun pullFromDataLayer(context: Context): Boolean {
        if (context.app.prefs.token != null) return true
        return try {
            // No host on the URI, so items from every connected node match.
            // TODO(verify): confirm getDataItems(uri) with a host-less wear:// URI matches all
            // nodes' items (the phone's WearRelay.clearConfig relies on the same thing). If not,
            // use NodeClient.connectedNodes and query wear://<nodeId>/sidekiqq/config.
            for (path in PhoneListenerService.CONFIG_PATHS) {
            val uri = Uri.Builder().scheme(PutDataRequest.WEAR_URI_SCHEME).path(path).build()
            val buffer = Wearable.getDataClient(context).getDataItems(uri).await()
            try {
                for (item in buffer) {
                    val map = DataMapItem.fromDataItem(item).dataMap
                    val token = map.getString(PhoneListenerService.KEY_TOKEN)
                    if (!token.isNullOrBlank()) {
                        map.getString(PhoneListenerService.KEY_BASE_URL)?.takeIf { it.isNotBlank() }
                            ?.let { context.app.prefs.baseUrl = it }
                        context.app.prefs.token = token
                        return true
                    }
                }
            } finally {
                buffer.release()
            }
            }
            false
        } catch (e: Exception) {
            Log.w("TokenSync", "Data Layer unavailable (standalone / no phone?)", e)
            false
        }
    }
}
