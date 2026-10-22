package com.sidekiqq.watch.ui.ask

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.sidekiqq.shared.model.Action
import com.sidekiqq.watch.app
import com.sidekiqq.watch.audio.Speaker
import com.sidekiqq.watch.audio.VoiceRecorder
import com.sidekiqq.watch.audio.WavAdapter
import com.sidekiqq.watch.logic.PushToTalk
import com.sidekiqq.watch.ui.components.userMessage
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface AskUi {
    data object Idle : AskUi

    /** [latched] means a quick tap started hands-free recording, so another tap sends. */
    data class Recording(val latched: Boolean) : AskUi
    data object Transcribing : AskUi
    data class Thinking(val question: String) : AskUi
    data class Answer(val question: String, val spoken: String, val reply: String, val actions: List<Action>) : AskUi
    data class Error(val message: String) : AskUi
}

class AskViewModel(application: Application) : AndroidViewModel(application) {

    private val app = application.app
    private val repo = app.repository
    private val speaker by lazy { Speaker(application) }

    private val _ui = MutableStateFlow<AskUi>(AskUi.Idle)
    val ui: StateFlow<AskUi> = _ui.asStateFlow()

    val isPaired: Boolean get() = repo.isPaired

    private var recorder: VoiceRecorder? = null
    private var recordJob: Job? = null

    /** Returns false (and does nothing) without RECORD_AUDIO; the screen then asks or falls back. */
    fun startRecording(): Boolean {
        if (ContextCompat.checkSelfPermission(getApplication<Application>(), Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) return false
        if (recordJob?.isActive == true) return true
        speaker.stop()
        val rec = VoiceRecorder().also { recorder = it }
        _ui.value = AskUi.Recording(latched = false)
        recordJob = viewModelScope.launch {
            val pcm = try {
                @Suppress("MissingPermission") // checked at the top of startRecording()
                rec.record()
            } catch (e: Exception) {
                _ui.value = AskUi.Error("Mic error: ${e.message}")
                return@launch
            }
            if (PushToTalk.isTooShort(pcm.size)) {
                _ui.value = AskUi.Idle
                return@launch
            }
            _ui.value = AskUi.Transcribing
            val text = try {
                repo.transcribe(WavAdapter.toWav(pcm, PushToTalk.SAMPLE_RATE)).trim()
            } catch (e: Exception) {
                _ui.value = AskUi.Error(e.userMessage())
                return@launch
            }
            if (text.isEmpty()) {
                _ui.value = AskUi.Error("Didn't catch that. Try again.")
            } else {
                askInternal(text)
            }
        }
        return true
    }

    fun latch() {
        val s = _ui.value
        if (s is AskUi.Recording) _ui.value = s.copy(latched = true)
    }

    /** Ends recording; the job then transcribes and asks. */
    fun stopAndSend() {
        recorder?.stop()
        recorder = null
    }

    fun cancelRecording() {
        recorder?.stop()
        recordJob?.cancel()
        recorder = null
        _ui.value = AskUi.Idle
    }

    /** RemoteInput fallback (no mic permission) and typed input. */
    fun askText(text: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        viewModelScope.launch { askInternal(t) }
    }

    private suspend fun askInternal(text: String) {
        _ui.value = AskUi.Thinking(text)
        _ui.value = try {
            val r = repo.ask(text)
            if (app.prefs.ttsEnabled) speaker.speak(r.spoken)
            AskUi.Answer(question = text, spoken = r.spoken, reply = r.reply, actions = r.actions)
        } catch (e: Exception) {
            AskUi.Error(e.userMessage())
        }
    }

    fun dismiss() {
        speaker.stop()
        _ui.value = AskUi.Idle
    }

    fun newConversation() {
        repo.resetConversation()
        dismiss()
    }

    override fun onCleared() {
        recorder?.stop()
        speaker.shutdown()
    }
}
