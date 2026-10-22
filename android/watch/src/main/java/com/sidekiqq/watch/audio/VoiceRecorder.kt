package com.sidekiqq.watch.audio

import android.Manifest
import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.annotation.RequiresPermission
import com.sidekiqq.watch.logic.PushToTalk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/**
 * Records 16 kHz mono PCM16 with AudioRecord until [stop] is called, the coroutine is cancelled,
 * or PushToTalk.MAX_RECORDING_MS is reached. Returns raw PCM; wrap it with [WavAdapter].
 *
 * One instance per recording.
 */
class VoiceRecorder(private val sampleRate: Int = PushToTalk.SAMPLE_RATE) {

    @Volatile private var stopRequested = false

    fun stop() {
        stopRequested = true
    }

    @SuppressLint("MissingPermission") // The caller is annotated; checked in AskScreen before calling.
    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    suspend fun record(): ByteArray = withContext(Dispatchers.IO) {
        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
        )
        require(minBuf > 0) { "AudioRecord does not support $sampleRate Hz mono PCM16 (code $minBuf)" }
        val bufSize = maxOf(minBuf, sampleRate / 5 * 2) // at least about 200 ms
        // VOICE_RECOGNITION turns off AGC/NS on most devices, which ASR prefers.
        val rec = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize,
        )
        check(rec.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord failed to initialise" }

        val out = ByteArrayOutputStream(sampleRate * 2 * 10)
        val buf = ByteArray(bufSize)
        val cap = PushToTalk.maxPcmBytes(sampleRate)
        try {
            rec.startRecording()
            while (!stopRequested && isActive && out.size() < cap) {
                val n = rec.read(buf, 0, buf.size)
                if (n > 0) out.write(buf, 0, minOf(n, cap - out.size()))
                else if (n < 0) error("AudioRecord.read failed: $n")
            }
        } finally {
            runCatching { rec.stop() }
            rec.release()
        }
        out.toByteArray()
    }
}
