package com.sidekiqq.phone.voice

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

/**
 * On-device/Google SpeechRecognizer, used by the phone talk button when available.
 * Returns null if nothing was recognized. Must run on the main thread (handled internally).
 */
object SpeechInput {

    fun isAvailable(context: Context): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    suspend fun listenOnce(context: Context): String? = withContext(Dispatchers.Main) {
        suspendCancellableCoroutine { cont ->
            val recognizer = SpeechRecognizer.createSpeechRecognizer(context)
            fun finish(result: String?) {
                if (cont.isActive) cont.resume(result)
                recognizer.destroy()
            }
            recognizer.setRecognitionListener(object : RecognitionListener {
                override fun onResults(results: Bundle?) {
                    finish(results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull())
                }
                override fun onError(error: Int) = finish(null)
                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            }
            recognizer.startListening(intent)
            cont.invokeOnCancellation {
                // destroy() must run on the main thread; cancellation may arrive elsewhere.
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    recognizer.cancel()
                    recognizer.destroy()
                }
            }
        }
    }
}
