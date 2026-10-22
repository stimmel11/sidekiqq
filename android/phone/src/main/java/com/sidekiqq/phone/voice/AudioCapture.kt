package com.sidekiqq.phone.voice

import android.Manifest
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.annotation.RequiresPermission
import com.sidekiqq.shared.audio.PcmBuffer
import com.sidekiqq.shared.audio.WavEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlin.math.sqrt

/**
 * Records one utterance as 16 kHz mono PCM16 with simple energy-based endpointing:
 * stops after [trailingSilenceMs] of quiet once speech has been heard, after [maxMs],
 * or after [noSpeechTimeoutMs] if nothing is said at all.
 */
class AudioCapture(
    private val audioSource: Int = MediaRecorder.AudioSource.VOICE_RECOGNITION,
    private val preferredDevice: AudioDeviceInfo? = null,
    private val maxMs: Long = 20_000,
    private val trailingSilenceMs: Long = 1_200,
    private val noSpeechTimeoutMs: Long = 6_000,
    private val speechRms: Double = 900.0,
) {
    /** Returns raw PCM16 LE bytes, or an empty array if no speech was detected. */
    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    suspend fun recordUtterance(): ByteArray = withContext(Dispatchers.IO) {
        val rate = WavEncoder.SAMPLE_RATE
        val minBuf = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val frameSamples = rate / 50 // 20 ms frames
        val record = AudioRecord.Builder()
            .setAudioSource(audioSource)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(rate)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .build()
            )
            .setBufferSizeInBytes(maxOf(minBuf, frameSamples * 2 * 10))
            .build()
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            error("AudioRecord failed to initialize")
        }
        preferredDevice?.let { record.setPreferredDevice(it) }

        val out = PcmBuffer()
        val frame = ShortArray(frameSamples)
        val frameBytes = java.nio.ByteBuffer.allocate(frameSamples * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        var heardSpeech = false
        var elapsedMs = 0L
        var silenceMs = 0L
        try {
            record.startRecording()
            while (currentCoroutineContext().isActive) {
                val n = record.read(frame, 0, frame.size)
                if (n <= 0) break
                frameBytes.clear()
                frameBytes.asShortBuffer().put(frame, 0, n)
                out.append(frameBytes.array(), 0, n * 2)

                val ms = n * 1000L / rate
                elapsedMs += ms
                if (rms(frame, n) >= speechRms) {
                    heardSpeech = true
                    silenceMs = 0
                } else {
                    silenceMs += ms
                }
                if (heardSpeech && silenceMs >= trailingSilenceMs) break
                if (!heardSpeech && elapsedMs >= noSpeechTimeoutMs) break
                if (elapsedMs >= maxMs) break
            }
        } finally {
            runCatching { record.stop() }
            record.release()
        }
        if (heardSpeech) out.toByteArray() else ByteArray(0)
    }

    private fun rms(buf: ShortArray, n: Int): Double {
        var sum = 0.0
        for (i in 0 until n) { val v = buf[i].toDouble(); sum += v * v }
        return sqrt(sum / n)
    }
}
