package com.sidekiqq.phone

import android.app.Application
import android.os.SystemClock
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.sidekiqq.phone.handoff.CommandInbox
import com.sidekiqq.phone.push.SideKiqqMessagingService
import com.sidekiqq.shared.SideKiqqApiException
import com.sidekiqq.shared.SideKiqqClient
import com.sidekiqq.shared.audio.WavEncoder
import com.sidekiqq.shared.model.AskResponse
import com.sidekiqq.shared.model.Brief
import com.sidekiqq.shared.model.BriefKind
import com.sidekiqq.shared.model.Commitment
import com.sidekiqq.shared.model.CommandResult
import com.sidekiqq.shared.model.CommitmentStatus
import com.sidekiqq.shared.model.Device
import com.sidekiqq.shared.model.DeviceCommand
import com.sidekiqq.shared.model.FollowUp
import com.sidekiqq.shared.model.Top5Response
import com.sidekiqq.shared.wear.WearReply
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class UiState(
    val paired: Boolean = false,
    val baseUrl: String = "",
    val loading: Boolean = false,
    val error: String? = null,
    val top5: Top5Response? = null,
    val followUps: List<FollowUp> = emptyList(),
    val commitments: List<Commitment> = emptyList(),
    val commitmentFilter: CommitmentStatus = CommitmentStatus.OPEN,
    val brief: Brief? = null,
    val briefKind: BriefKind = BriefKind.DAILY,
    val talking: TalkState = TalkState.Idle,
    val lastAnswer: AskResponse? = null,
    val lastQuestion: String? = null,
    val snackbar: String? = null,
    /** Hand-offs queued for this phone (GET /api/commands), oldest first. Shown; acted on only after a tap. */
    val handoffs: List<DeviceCommand> = emptyList(),
)

enum class TalkState { Idle, Listening, Thinking, Speaking }

class MainViewModel(application: Application) : AndroidViewModel(application) {

    private val app = application as SideKiqqApp
    private val store = app.tokenStore
    private val _ui = MutableStateFlow(UiState(paired = store.isPaired, baseUrl = store.baseUrl.orEmpty()))
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private var conversationId: String? = null

    private val inbox = CommandInbox()
    private var lastPolledCommands: List<DeviceCommand> = emptyList()
    private var pollJob: Job? = null
    private var repollRequested = false // main thread only (viewModelScope / UI callers)
    private var lastOkPollAt = 0L // SystemClock.elapsedRealtime(), not the wall clock

    init {
        if (store.isPaired) refreshAll()
    }

    private fun client(): SideKiqqClient? = app.client()

    private fun fail(e: Throwable, what: String) {
        Log.w(TAG, what, e)
        val msg = when {
            e is SideKiqqApiException && e.status == 401 -> "Not authorized. Re-pair this phone."
            e is SideKiqqApiException -> "$what failed (${e.status})"
            else -> "$what failed: ${e.message ?: e::class.simpleName}"
        }
        _ui.update { it.copy(error = msg, loading = false) }
    }

    fun consumeSnackbar() = _ui.update { it.copy(snackbar = null, error = null) }

    // ------------------------------------------------------------ pairing

    fun pair(baseUrl: String, code: String) {
        val url = baseUrl.trim().trimEnd('/')
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            _ui.update { it.copy(error = "Server URL must start with https://") }
            return
        }
        if (!Regex("^\\d{6}$").matches(code.trim())) {
            _ui.update { it.copy(error = "Pairing code is 6 digits") }
            return
        }
        _ui.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                val token = SideKiqqClient(url, { null }).use { it.pair(code.trim()) }
                store.baseUrl = url
                store.saveToken(token)
                _ui.update { it.copy(paired = true, baseUrl = url, loading = false, snackbar = "Paired") }
                app.wearRelay.pushConfig(url, token)
                SideKiqqMessagingService.refreshRegistration(app)
                refreshAll()
            } catch (e: Exception) {
                fail(e, "Pairing")
            }
        }
    }

    fun unpair() {
        store.clear()
        viewModelScope.launch { app.wearRelay.clearConfig() }
        conversationId = null
        pollJob?.cancel()
        lastPolledCommands = emptyList()
        _ui.value = UiState(paired = false)
    }

    // ------------------------------------------------------------ data

    fun refreshAll() {
        val c = client() ?: return
        _ui.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                // coroutineScope{} so a failed child is rethrown here (and caught) instead of crashing viewModelScope.
                coroutineScope {
                    val top = async { c.top5() }
                    val fus = async { c.followUps() }
                    val cms = async { c.commitments(_ui.value.commitmentFilter) }
                    val (t, f, cm) = Triple(top.await(), fus.await(), cms.await())
                    _ui.update { it.copy(top5 = t, followUps = f, commitments = cm, loading = false) }
                }
                pollCommands()
            } catch (e: Exception) {
                fail(e, "Refresh")
            }
        }
    }

    // ------------------------------------------------------------ device commands (hand-offs)

    /**
     * Polls GET /api/commands. Called on app start/resume and every 30 s while the app is visible
     * (MainActivity). Polling only shows hand-offs; nothing is opened until the owner taps.
     * Failures are logged, not shown: a missed poll just means the next one picks it up.
     */
    fun pollCommands(force: Boolean = false) {
        val c = client() ?: return
        if (pollJob?.isActive == true) {
            // An FCM nudge can arrive while a poll that started before the command was queued is
            // still in flight; poll once more after it so the new hand-off isn't missed for 30 s.
            if (force) repollRequested = true
            return
        }
        repollRequested = false
        pollJob = viewModelScope.launch {
            try {
                val polled = c.commands()
                lastPolledCommands = polled
                lastOkPollAt = SystemClock.elapsedRealtime()
                _ui.update { it.copy(handoffs = inbox.visible(polled)) }
                // A "Hand-off waiting" prompt posted in a race with the app opening is now stale.
                if (app.handoffsVisible) SideKiqqMessagingService.clearHandoffWaiting(app)
                // Handled here but still listed: the earlier ack was lost. Same result again is a no-op.
                inbox.unackedHandled(polled).forEach { (id, result) -> sendAck(c, id, result) }
            } catch (e: Exception) {
                Log.w(TAG, "Poll commands", e)
                // Liveness comes from the brain. If we can't confirm it for a while, stop showing them.
                if (SystemClock.elapsedRealtime() - lastOkPollAt > STALE_COMMANDS_MS) clearCommands()
            }
        }
        pollJob?.invokeOnCompletion { cause ->
            // Not after a cancel (backgrounded/unpaired): the next poll must come from a resume.
            if (cause == null && repollRequested) viewModelScope.launch { if (app.handoffsVisible) pollCommands() }
        }
    }

    /** The app went to the background: hand-offs shown later must come from a fresh poll. */
    fun onCommandsHidden() {
        repollRequested = false
        pollJob?.cancel()
        clearCommands()
    }

    private fun clearCommands() {
        lastPolledCommands = emptyList()
        _ui.update { it.copy(handoffs = emptyList()) }
    }

    /**
     * Claims a hand-off the owner just tapped (open or dismiss) and hides it at once. Returns false
     * if it was already handled, so a double tap can't open it twice. Call before acting on it.
     */
    fun claimHandoff(cmd: DeviceCommand, intended: CommandResult): Boolean {
        val first = inbox.markHandled(cmd.id, intended)
        _ui.update { it.copy(handoffs = inbox.visible(lastPolledCommands)) }
        return first
    }

    /**
     * Acks a claimed hand-off. MainActivity sends OPENED only after the owner tapped the open
     * button and the intent started, FAILED if no app could open it, DISMISSED for Dismiss.
     */
    fun ackHandoff(cmd: DeviceCommand, result: CommandResult) {
        inbox.setResult(cmd.id, result)
        val c = client() ?: return
        sendAck(c, cmd.id, result)
    }

    private fun sendAck(c: SideKiqqClient, id: String, result: CommandResult) {
        viewModelScope.launch {
            try {
                c.ackCommand(id, result)
            } catch (e: SideKiqqApiException) {
                // 404 gone/not ours, 409 already acked differently, 410 expired: nothing to do.
                Log.w(TAG, "Ack command $id -> ${e.status}")
            } catch (e: Exception) {
                // Network: re-sent on the next poll while the brain still lists it.
                Log.w(TAG, "Ack command $id", e)
            }
        }
    }

    fun setCommitmentFilter(status: CommitmentStatus) {
        _ui.update { it.copy(commitmentFilter = status) }
        val c = client() ?: return
        viewModelScope.launch {
            runCatching { c.commitments(status) }
                .onSuccess { list -> _ui.update { it.copy(commitments = list) } }
                .onFailure { fail(it, "Commitments") }
        }
    }

    fun completeCommitment(id: String) {
        val c = client() ?: return
        viewModelScope.launch {
            try {
                c.completeCommitment(id)
                _ui.update { s -> s.copy(commitments = s.commitments.filterNot { it.id == id }, snackbar = "Marked done") }
            } catch (e: Exception) {
                fail(e, "Mark done")
            }
        }
    }

    /**
     * Sends a draft. The UI MUST call this only from the confirm button of the approval dialog.
     * This is the only code path on the phone UI that sends anything.
     */
    fun approveDraftConfirmed(followUp: FollowUp) {
        val draftId = followUp.draftId ?: return
        val c = client() ?: return
        viewModelScope.launch {
            try {
                c.approveDraft(draftId)
                _ui.update { s ->
                    s.copy(followUps = s.followUps.filterNot { it.id == followUp.id }, snackbar = "Sent to ${followUp.person}")
                }
            } catch (e: Exception) {
                fail(e, "Send")
            }
        }
    }

    fun loadBrief(kind: BriefKind) {
        val c = client() ?: return
        _ui.update { it.copy(briefKind = kind, loading = true) }
        viewModelScope.launch {
            try {
                val b = c.brief(kind)
                _ui.update { it.copy(brief = b, loading = false) }
            } catch (e: Exception) {
                fail(e, "Brief")
            }
        }
    }

    // ------------------------------------------------------------ talk

    fun setTalking(t: TalkState) = _ui.update { it.copy(talking = t) }

    /** Called with recognized text (SpeechRecognizer) or after /api/transcribe on recorded PCM. */
    fun ask(text: String) {
        val c = client() ?: return
        if (text.isBlank()) { setTalking(TalkState.Idle); return }
        _ui.update { it.copy(talking = TalkState.Thinking, lastQuestion = text) }
        viewModelScope.launch {
            try {
                val r = c.ask(text, Device.PHONE, conversationId)
                conversationId = r.conversationId
                _ui.update { it.copy(lastAnswer = r, talking = TalkState.Speaking) }
                app.wearRelay.sendReply(WearReply(r.reply, r.spoken, r.conversationId, Device.PHONE.wire, r.actions))
                app.speaker.speak(r.spoken.ifBlank { r.reply })
                // Drafts created here show up under Follow-ups / in the answer card and need the confirm dialog.
                refreshAll()
            } catch (e: Exception) {
                fail(e, "Ask")
            } finally {
                setTalking(TalkState.Idle)
            }
        }
    }

    fun askFromPcm(pcm: ByteArray) {
        val c = client() ?: return
        if (pcm.isEmpty()) { setTalking(TalkState.Idle); return }
        _ui.update { it.copy(talking = TalkState.Thinking) }
        viewModelScope.launch {
            try {
                ask(c.transcribe(WavEncoder.encode(pcm)))
            } catch (e: Exception) {
                setTalking(TalkState.Idle)
                fail(e, "Transcribe")
            }
        }
    }

    fun stopSpeaking() {
        app.speaker.stop()
        setTalking(TalkState.Idle)
    }

    /** Approve a draft surfaced in an /api/ask answer. UI MUST call only after the confirm dialog. */
    fun approveAnswerDraftConfirmed(draftId: String, summary: String) {
        val c = client() ?: return
        viewModelScope.launch {
            try {
                c.approveDraft(draftId)
                _ui.update { s ->
                    s.copy(
                        lastAnswer = s.lastAnswer?.let { a -> a.copy(actions = a.actions.filterNot { it.id == draftId }) },
                        snackbar = "Sent: $summary",
                    )
                }
            } catch (e: Exception) {
                fail(e, "Send")
            }
        }
    }

    private companion object {
        const val TAG = "SideKiqqVM"
        const val STALE_COMMANDS_MS = 60_000L
    }
}
