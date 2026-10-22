package com.sidekiqq.phone.glasses

import android.Manifest
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaRecorder
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.annotation.RequiresPermission
import androidx.xr.projected.ProjectedContext
import androidx.xr.projected.experimental.ExperimentalProjectedApi
import com.sidekiqq.phone.voice.AudioCapture
import com.sidekiqq.phone.voice.Earcons
import com.sidekiqq.phone.voice.Speaker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Galaxy Glasses via Jetpack XR's Projected API (androidx.xr.projected:projected:1.0.0-alpha13).
 *
 * VERIFIED against the published ProjectedContext.kt source / developer.android.com docs (Oct 2026):
 *   @ExperimentalProjectedApi object ProjectedContext {
 *     @RequiresApi(34) fun createProjectedDeviceContext(context: Context): Context   // throws IllegalStateException
 *     @RequiresApi(35) fun createProjectedActivityOptions(context: Context): ActivityOptions
 *     @RequiresApi(36) fun isProjectedDeviceConnected(context: Context, coroutineContext: CoroutineContext): Flow<Boolean>
 *   }
 *   annotation: androidx.xr.projected.experimental.ExperimentalProjectedApi
 *
 * The Projected API needs API 36 for connection monitoring; [isSupported] gates it and
 * [GlassesBridgeFactory] falls back to [BluetoothHeadsetGlassesBridge] otherwise.
 *
 * Audio: Google's guide says glasses' mic is reached over Bluetooth HFP. Find the TYPE_BLUETOOTH_SCO input from
 * the projected context's AudioManager, record with VOICE_COMMUNICATION, then setPreferredDevice + setCommunicationDevice.
 */
// TODO(xr-api): Google's samples use Kotlin's @OptIn(ExperimentalProjectedApi::class). If the annotation turns out to
//   be androidx.annotation.RequiresOptIn instead of kotlin.RequiresOptIn, switch to androidx.annotation.OptIn.
@OptIn(ExperimentalProjectedApi::class)
@RequiresApi(Build.VERSION_CODES.BAKLAVA)
class ProjectedGlassesBridge(
    /** Prefer an Activity or Service context. The KDoc warns an Application context can flip deviceId. */
    private val hostContext: Context,
    private val fallbackSpeaker: Speaker,
) : GlassesBridge {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var monitorJob: Job? = null
    private val _connected = MutableStateFlow(false)

    @Volatile private var projectedContext: Context? = null
    @Volatile private var glassesSpeaker: Speaker? = null

    override val label = "Galaxy Glasses (projected)"
    override val connected: StateFlow<Boolean> = _connected.asStateFlow()

    /**
     * Touchpad taps arrive from [GlassesActivity] (dispatchGenericMotionEvent / Compose clickable)
     * via [GlassesWakeBus].
     * TODO(xr-api): ProjectedActivityCompat.create(activity).projectedInputEvents exposes hardware actions
     *   (docs show only TOGGLE_APP_CAMERA). If a dedicated "assistant"/tap action is added, subscribe to it
     *   in GlassesActivity. Signature unverified, so it is not called here.
     */
    override val wakeEvents: Flow<Unit> = GlassesWakeBus.events

    override suspend fun start() {
        if (monitorJob?.isActive == true) return
        monitorJob = scope.launch {
            // isProjectedDeviceConnected requires a CoroutineDispatcher in the passed context.
            ProjectedContext.isProjectedDeviceConnected(hostContext, coroutineContext)
                .collectLatest { isConnected ->
                    if (isConnected) onConnected() else onDisconnected()
                }
        }
    }

    private fun onConnected() {
        val ctx = try {
            ProjectedContext.createProjectedDeviceContext(hostContext)
        } catch (e: IllegalStateException) {
            Log.e(TAG, "Projected device reported connected but context creation failed", e)
            _connected.value = false
            return
        }
        projectedContext = ctx
        // TODO(xr-api): it is not documented whether TextToSpeech created from a projected device
        //   context plays on the glasses' speakers. Google's audio-output guidance for glasses points at
        //   "Handle audio output using Text to Speech". We create TTS with the projected context and rely on
        //   BT A2DP routing as a backstop. Verify on hardware/emulator and drop the fallback if it isn't needed.
        glassesSpeaker?.shutdown()
        glassesSpeaker = Speaker(ctx)
        _connected.value = true
        Log.i(TAG, "Glasses connected")
    }

    private fun onDisconnected() {
        // "The projected context is destroyed when the device disconnects": drop everything derived from it.
        projectedContext = null
        glassesSpeaker?.shutdown()
        glassesSpeaker = null
        _connected.value = false
        Log.i(TAG, "Glasses disconnected")
    }

    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    override suspend fun listen(): ByteArray {
        val ctx = projectedContext ?: hostContext
        val audio = ctx.getSystemService(AudioManager::class.java)
            ?: return ByteArray(0)
        val hfp = audio.getDevices(AudioManager.GET_DEVICES_INPUTS)
            .firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        if (hfp == null) Log.w(TAG, "No HFP input on glasses; recording from default mic")

        // From Google's "Use a projected context" guide: route recording to the BT device.
        val routed = hfp != null && audio.setCommunicationDevice(hfp)
        try {
            if (routed) delay(SCO_SETTLE_MS)
            return AudioCapture(
                audioSource = MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                preferredDevice = hfp,
            ).recordUtterance()
        } finally {
            if (routed) audio.clearCommunicationDevice()
        }
    }

    override suspend fun speak(text: String) {
        (glassesSpeaker ?: fallbackSpeaker).speak(text)
    }

    override suspend fun cueListening() = Earcons.listen()

    override fun stop() {
        monitorJob?.cancel()
        monitorJob = null
        onDisconnected()
    }

    override fun close() {
        stop()
        scope.cancel()
    }

    private companion object {
        const val TAG = "SideKiqqXrGlasses"
        const val SCO_SETTLE_MS = 400L
    }
}

/** Picks the projected bridge on Android 16+ (when the XR library is usable), else the BT headset fallback. */
object GlassesBridgeFactory {
    fun create(context: Context, phoneSpeaker: Speaker): GlassesBridge {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
            try {
                return ProjectedGlassesBridge(context, phoneSpeaker)
            } catch (e: LinkageError) {
                // Library or platform services missing on this build: degrade gracefully.
                Log.w("SideKiqqGlasses", "Projected API unavailable, using BT headset bridge", e)
            }
        }
        return BluetoothHeadsetGlassesBridge(context, phoneSpeaker)
    }
}
