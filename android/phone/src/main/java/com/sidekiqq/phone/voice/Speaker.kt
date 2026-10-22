package com.sidekiqq.phone.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Suspend-friendly TextToSpeech wrapper.
 *
 * Audio uses USAGE_ASSISTANT / CONTENT_TYPE_SPEECH, so Android routes it to the active output
 * (Bluetooth glasses or earbuds over A2DP when connected, otherwise the phone speaker).
 *
 * @param context pass a projected-device Context to make TTS use the glasses' audio device
 *   (see ProjectedGlassesBridge); defaults to the phone.
 */
class Speaker(context: Context) {

    private val appContext = context
    private val audioManager = context.getSystemService(AudioManager::class.java)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<Unit>>()
    private val speakLock = Mutex()
    private val ready = CompletableDeferred<Boolean>()

    private val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    // The init listener can fire before `tts` is assigned, so configuration happens lazily in speak().
    private val tts: TextToSpeech = TextToSpeech(appContext) { status ->
        if (status != TextToSpeech.SUCCESS) Log.e(TAG, "TTS init failed: $status")
        ready.complete(status == TextToSpeech.SUCCESS)
    }
    @Volatile private var configured = false

    private fun configure() {
        if (configured) return
        configured = true
        tts.setAudioAttributes(attrs)
        tts.setLanguage(Locale.getDefault()) // returns Int, so it is not a Kotlin property setter
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) {}
            override fun onDone(utteranceId: String) { pending.remove(utteranceId)?.complete(Unit) }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String) { pending.remove(utteranceId)?.complete(Unit) }
            override fun onError(utteranceId: String, errorCode: Int) { pending.remove(utteranceId)?.complete(Unit) }
            override fun onStop(utteranceId: String, interrupted: Boolean) { pending.remove(utteranceId)?.complete(Unit) }
        })
    }

    /** Speaks [text] and suspends until playback ends (or ~60 s safety timeout). */
    suspend fun speak(text: String) {
        if (text.isBlank()) return
        if (!ready.await()) return
        speakLock.withLock {
            configure()
            val id = UUID.randomUUID().toString()
            val done = CompletableDeferred<Unit>()
            pending[id] = done
            val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(attrs)
                .build()
            audioManager?.requestAudioFocus(focus)
            try {
                if (tts.speak(text, TextToSpeech.QUEUE_ADD, Bundle(), id) != TextToSpeech.SUCCESS) {
                    pending.remove(id)
                    return
                }
                withTimeoutOrNull(60_000) { done.await() }
            } finally {
                pending.remove(id)
                audioManager?.abandonAudioFocusRequest(focus)
            }
        }
    }

    fun stop() {
        tts.stop()
        pending.values.forEach { it.complete(Unit) }
        pending.clear()
    }

    fun shutdown() {
        stop()
        tts.shutdown()
    }

    private companion object { const val TAG = "SideKiqqSpeaker" }
}

/** Short "listening" / "error" cue sounds without needing audio assets. */
object Earcons {
    suspend fun listen() = tone(android.media.ToneGenerator.TONE_PROP_BEEP, 120)
    suspend fun done() = tone(android.media.ToneGenerator.TONE_PROP_ACK, 150)
    suspend fun error() = tone(android.media.ToneGenerator.TONE_PROP_NACK, 250)

    private suspend fun tone(type: Int, ms: Int) {
        val gen = try {
            android.media.ToneGenerator(AudioManager.STREAM_MUSIC, 70)
        } catch (e: RuntimeException) {
            return // no audio hardware available
        }
        try {
            gen.startTone(type, ms)
            kotlinx.coroutines.delay(ms.toLong() + 30)
        } finally {
            gen.release()
        }
    }
}
