package com.sidekiqq.watch.notify

import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.sidekiqq.watch.logic.HapticPattern

object Haptics {

    private fun vibrator(context: Context): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }

    /**
     * Plays [pattern] once. [urgent] uses ALARM usage, so a CRITICAL alert still buzzes when the
     * vibration comes from a background service (the WearableListenerService).
     *
     * TODO(verify-on-device): background-vibration rules vary by API level and OEM. Check that a
     * CRITICAL alert buzzes on a Galaxy Watch (Wear OS 5 / One UI Watch) with the screen off.
     * If not, rely on the critical NotificationChannel's vibration pattern instead.
     */
    fun play(context: Context, pattern: HapticPattern, urgent: Boolean = false) {
        if (pattern.isSilent) return
        val v = vibrator(context) ?: return
        if (!v.hasVibrator()) return
        val amps = if (v.hasAmplitudeControl()) pattern.amplitudes
        else IntArray(pattern.amplitudes.size) { i -> if (pattern.amplitudes[i] > 0) VibrationEffect.DEFAULT_AMPLITUDE else 0 }
        val effect = VibrationEffect.createWaveform(pattern.timings, amps, -1)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val usage = if (urgent) VibrationAttributes.USAGE_ALARM else VibrationAttributes.USAGE_NOTIFICATION
            v.vibrate(effect, VibrationAttributes.createForUsage(usage))
        } else {
            val usage = if (urgent) AudioAttributes.USAGE_ALARM else AudioAttributes.USAGE_NOTIFICATION
            @Suppress("DEPRECATION")
            v.vibrate(effect, AudioAttributes.Builder().setUsage(usage).build())
        }
    }
}
