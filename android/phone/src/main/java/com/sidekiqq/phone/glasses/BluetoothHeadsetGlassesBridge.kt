package com.sidekiqq.phone.glasses

import android.Manifest
import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.RequiresPermission
import com.sidekiqq.phone.voice.AudioCapture
import com.sidekiqq.phone.voice.Earcons
import com.sidekiqq.phone.voice.Speaker
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Fallback: treat the glasses (or any earbuds) as a standard Bluetooth headset.
 *  - Mic: route the communication device to Bluetooth SCO (HFP) and record with VOICE_COMMUNICATION.
 *  - Audio: TTS on the media route (A2DP) after SCO is released.
 * Only stable platform APIs are used here.
 */
class BluetoothHeadsetGlassesBridge(
    context: Context,
    private val speaker: Speaker,
) : GlassesBridge {

    private val appContext = context.applicationContext
    private val audio = appContext.getSystemService(AudioManager::class.java)
    private val _connected = MutableStateFlow(false)
    private var callbackRegistered = false

    override val label = "Bluetooth headset"
    override val connected: StateFlow<Boolean> = _connected.asStateFlow()
    override val wakeEvents: Flow<Unit> = GlassesWakeBus.events

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = refresh()
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = refresh()
    }

    override suspend fun start() {
        if (!callbackRegistered) {
            audio.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
            callbackRegistered = true
        }
        refresh()
    }

    private fun refresh() {
        _connected.value = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.isBluetoothHeadset() }
    }

    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    override suspend fun listen(): ByteArray {
        val sco = routeMicToSco()
        try {
            val input = audio.getDevices(AudioManager.GET_DEVICES_INPUTS)
                .firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET }
            if (input == null) Log.w(TAG, "No BT mic input found; falling back to default mic")
            return AudioCapture(
                audioSource = MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                preferredDevice = input,
            ).recordUtterance()
        } finally {
            releaseSco(sco)
        }
    }

    override suspend fun speak(text: String) = speaker.speak(text)

    override suspend fun cueListening() = Earcons.listen()

    override fun stop() {
        if (callbackRegistered) {
            audio.unregisterAudioDeviceCallback(deviceCallback)
            callbackRegistered = false
        }
        _connected.value = false
    }

    // ---------------------------------------------------------------- SCO routing

    private enum class Route { MODERN, LEGACY, NONE }

    private suspend fun routeMicToSco(): Route {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val dev = audio.availableCommunicationDevices.firstOrNull {
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
            } ?: return Route.NONE
            return if (audio.setCommunicationDevice(dev)) {
                delay(SCO_SETTLE_MS) // HFP link takes a moment to come up
                Route.MODERN
            } else Route.NONE
        }
        @Suppress("DEPRECATION")
        run {
            if (!audio.isBluetoothScoAvailableOffCall) return Route.NONE
            audio.mode = AudioManager.MODE_IN_COMMUNICATION
            audio.startBluetoothSco()
            audio.isBluetoothScoOn = true
        }
        delay(SCO_SETTLE_MS)
        return Route.LEGACY
    }

    private fun releaseSco(route: Route) {
        when (route) {
            Route.MODERN -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audio.clearCommunicationDevice()
            Route.LEGACY -> @Suppress("DEPRECATION") run {
                audio.isBluetoothScoOn = false
                audio.stopBluetoothSco()
                audio.mode = AudioManager.MODE_NORMAL
            }
            Route.NONE -> Unit
        }
    }

    private fun AudioDeviceInfo.isBluetoothHeadset() = when (type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLE_HEADSET -> true
        else -> false
    }

    private companion object {
        const val TAG = "SideKiqqBtGlasses"
        const val SCO_SETTLE_MS = 600L
    }
}
