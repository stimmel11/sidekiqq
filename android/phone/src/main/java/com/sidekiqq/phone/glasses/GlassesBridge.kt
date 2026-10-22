package com.sidekiqq.phone.glasses

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/**
 * Everything SideKiqq needs from a pair of glasses. All XR / Bluetooth specifics stay behind this
 * interface so the session logic in [GlassesSessionService] never touches androidx.xr directly.
 *
 * Implementations:
 *  - [ProjectedGlassesBridge]: Jetpack XR Projected API (androidx.xr.projected), Android 16+
 *  - [BluetoothHeadsetGlassesBridge]: fallback that treats the glasses as a plain BT headset (SCO mic + A2DP/SCO audio)
 */
interface GlassesBridge {
    /** Human-readable kind, for the UI ("Galaxy Glasses (projected)", "Bluetooth headset"). */
    val label: String

    /** True while the glasses are connected and usable. */
    val connected: StateFlow<Boolean>

    /**
     * Wake requests coming from the glasses themselves (e.g. a touchpad tap routed by
     * [GlassesActivity]). Phone-side "Hey SideKiqq" buttons call [GlassesSessionService.wake] directly.
     */
    val wakeEvents: Flow<Unit>

    /** Start monitoring connection state / acquire resources. Idempotent. */
    suspend fun start()

    /**
     * Record one utterance through the glasses microphone and return 16 kHz mono PCM16 LE bytes
     * (empty if nothing was said). Requires RECORD_AUDIO (+ BLUETOOTH_CONNECT for SCO routing).
     */
    suspend fun listen(): ByteArray

    /** Speak [text] through the glasses speakers and suspend until playback finishes. */
    suspend fun speak(text: String)

    /** Short audible cue that SideKiqq is listening. */
    suspend fun cueListening()

    /** Release everything. The bridge may be [start]ed again afterwards. */
    fun stop()

    /** Release permanently (the bridge is not reused). */
    fun close() = stop()
}
