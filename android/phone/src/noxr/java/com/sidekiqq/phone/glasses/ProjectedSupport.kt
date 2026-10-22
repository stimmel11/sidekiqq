package com.sidekiqq.phone.glasses

import android.app.Activity
import android.content.Context
import android.os.Bundle
import com.sidekiqq.phone.voice.Speaker

/**
 * Stub used when the app is built with `-Psidekiqq.xr=false`, i.e. without the alpha
 * androidx.xr.projected dependency. Glasses still work through [BluetoothHeadsetGlassesBridge]
 * (SCO mic in, TTS out); only the projected display/launcher integration is missing.
 *
 * TODO(xr-api): this exists so a broken or unresolvable XR alpha never blocks the rest of the
 *   app from building. Keep its signatures in sync with src/xr/.../ProjectedSupport.kt.
 */
internal object ProjectedSupport {

    const val COMPILED_IN = false

    @Suppress("UNUSED_PARAMETER")
    fun createBridge(context: Context, phoneSpeaker: Speaker): GlassesBridge? = null

    @Suppress("UNUSED_PARAMETER")
    fun hostContext(activity: Activity): Context? = null

    @Suppress("UNUSED_PARAMETER")
    fun projectedActivityOptions(context: Context): Bundle? = null
}
