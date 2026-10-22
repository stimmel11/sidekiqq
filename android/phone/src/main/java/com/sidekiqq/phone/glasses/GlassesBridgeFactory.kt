package com.sidekiqq.phone.glasses

import android.content.Context
import android.util.Log
import com.sidekiqq.phone.voice.Speaker

/**
 * Picks the Jetpack XR projected bridge on Android 16+ when this build includes it
 * ([ProjectedSupport.COMPILED_IN]), otherwise the Bluetooth-headset fallback.
 */
object GlassesBridgeFactory {
    fun create(context: Context, phoneSpeaker: Speaker): GlassesBridge {
        try {
            ProjectedSupport.createBridge(context, phoneSpeaker)?.let { return it }
        } catch (e: LinkageError) {
            // Library or platform services missing on this device: degrade gracefully.
            Log.w(TAG, "Projected API unavailable, using BT headset bridge", e)
        } catch (e: RuntimeException) {
            Log.w(TAG, "Projected bridge failed to initialise, using BT headset bridge", e)
        }
        return BluetoothHeadsetGlassesBridge(context, phoneSpeaker)
    }

    private const val TAG = "SideKiqqGlasses"
}
