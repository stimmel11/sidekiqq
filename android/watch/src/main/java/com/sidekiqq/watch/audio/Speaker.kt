package com.sidekiqq.watch.audio

import android.content.Context
import android.speech.tts.TextToSpeech
import java.util.Locale

/**
 * Thin wrapper around TextToSpeech. Utterances requested before the engine is ready are queued
 * and the most recent one is spoken. Call [shutdown] from onDestroy.
 */
class Speaker(context: Context) : TextToSpeech.OnInitListener {
    private var ready = false
    private var pending: String? = null
    private val tts = TextToSpeech(context.applicationContext, this)

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            tts.language = Locale.getDefault()
            ready = true
            pending?.let { speak(it) }
            pending = null
        }
    }

    fun speak(text: String) {
        if (text.isBlank()) return
        if (!ready) {
            pending = text
            return
        }
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "sidekiqq-${System.currentTimeMillis()}")
    }

    fun stop() {
        if (ready) tts.stop()
    }

    fun shutdown() {
        tts.stop()
        tts.shutdown()
    }
}
