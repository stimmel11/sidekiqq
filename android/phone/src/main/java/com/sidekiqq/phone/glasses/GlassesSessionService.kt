package com.sidekiqq.phone.glasses

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log
import androidx.core.content.ContextCompat
import com.sidekiqq.phone.MainActivity
import com.sidekiqq.phone.R
import com.sidekiqq.phone.SideKiqqApp
import com.sidekiqq.phone.assistant.VoiceAssistant
import com.sidekiqq.phone.assistant.VoiceOutput
import com.sidekiqq.phone.sideKiqqApp
import com.sidekiqq.phone.voice.Earcons
import com.sidekiqq.shared.model.Device
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class GlassesState(
    val running: Boolean = false,
    val bridge: String? = null,
    val connected: Boolean = false,
    val phase: Phase = Phase.IDLE,
    val lastTranscript: String? = null,
    val lastReply: String? = null,
    val awaitingConfirm: Boolean = false,
) {
    enum class Phase { IDLE, LISTENING, THINKING, SPEAKING, CONFIRMING }
}

/**
 * Runs the glasses voice session on the phone.
 *
 * Wake: there is no always-on hotword. A session turn starts only on an explicit "Hey SideKiqq"
 * action, either the phone button ([wake]) or a tap on the glasses touchpad ([GlassesActivity] -> [GlassesWakeBus]).
 *
 * Turn: earcon -> listen through glasses mic -> transcribe -> ask(device = glasses) -> speak `spoken` on glasses.
 * If the brain created a draft, SideKiqq asks "Send this: …? Say 'send it' to confirm" and listens ONE more time.
 * Only an exact "send it" approves; anything else (or silence) leaves the draft unsent.
 */
class GlassesSessionService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var bridge: GlassesBridge
    private lateinit var assistant: VoiceAssistant
    private var turnJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val app = sideKiqqApp
        // A Service context (not the Application) per the ProjectedContext KDoc.
        bridge = GlassesBridgeFactory.create(this, app.speaker)
        assistant = VoiceAssistant(app::client, app.wearRelay)
        _state.update { it.copy(bridge = bridge.label) }
        scope.launch { bridge.connected.collect { c -> _state.update { it.copy(connected = c) } } }
        scope.launch { bridge.wakeEvents.collect { startTurn() } }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
        }
        // NOTE: Android 14+ only allows a microphone FGS to start while the app is visible (or from an exempt
        // path). The phone button, notification action and the visible GlassesActivity all qualify. A wake from a
        // fully backgrounded app would throw ForegroundServiceStartNotAllowedException, which is caught below.
        if (!hasMicPermission(this)) {
            Log.e(TAG, "RECORD_AUDIO not granted; glasses session cannot start")
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            startForeground(
                NOTIFICATION_ID,
                notification("Tap your glasses or press Hey SideKiqq"),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } catch (e: Exception) {
            Log.e(TAG, "Cannot start glasses session in the foreground now", e)
            stopSelf()
            return START_NOT_STICKY
        }
        _state.update { it.copy(running = true) }
        scope.launch { bridge.start() }
        if (intent?.action == ACTION_WAKE) startTurn()
        return START_STICKY
    }

    override fun onDestroy() {
        turnJob?.cancel()
        assistant.cancelPendingDraft()
        bridge.close()
        scope.cancel()
        _state.value = GlassesState()
        super.onDestroy()
    }

    private fun startTurn() {
        if (turnJob?.isActive == true) {
            Log.d(TAG, "Turn already in progress; ignoring wake")
            return
        }
        turnJob = scope.launch { runTurn() }
    }

    @Suppress("MissingPermission") // checked in onStartCommand
    private suspend fun runTurn() {
        val output = VoiceOutput { text ->
            setPhase(GlassesState.Phase.SPEAKING)
            bridge.speak(text)
        }
        try {
            setPhase(GlassesState.Phase.LISTENING)
            bridge.cueListening()
            val pcm = bridge.listen()
            setPhase(GlassesState.Phase.THINKING)
            var outcome = assistant.handleUtterance(pcm, Device.GLASSES, output)
            record(outcome)

            // Strict voice confirmation: exactly one more listen, then the draft is resolved either way.
            if (outcome is VoiceAssistant.Outcome.Answered && outcome.awaitingConfirm) {
                setPhase(GlassesState.Phase.CONFIRMING)
                _state.update { it.copy(awaitingConfirm = true) }
                bridge.cueListening()
                val answer = bridge.listen()
                setPhase(GlassesState.Phase.THINKING)
                outcome = assistant.handleUtterance(answer, Device.GLASSES, output)
                if (outcome is VoiceAssistant.Outcome.NothingHeard) {
                    // Silence is never consent.
                    assistant.cancelPendingDraft()
                    output.speak(VoiceAssistant.NOT_SENT)
                }
                record(outcome)
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Glasses turn failed", e)
            Earcons.error()
        } finally {
            assistant.cancelPendingDraft()
            _state.update { it.copy(awaitingConfirm = false) }
            setPhase(GlassesState.Phase.IDLE)
        }
    }

    private fun record(o: VoiceAssistant.Outcome) {
        if (o is VoiceAssistant.Outcome.Answered) {
            _state.update { it.copy(lastTranscript = o.transcript, lastReply = o.response.reply) }
        }
    }

    private fun setPhase(p: GlassesState.Phase) = _state.update { it.copy(phase = p) }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val wake = PendingIntent.getService(
            this, 2, Intent(this, GlassesSessionService::class.java).setAction(ACTION_WAKE), PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 3, Intent(this, GlassesSessionService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, SideKiqqApp.CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_sidekiqq)
            .setContentTitle("SideKiqq glasses")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Hey SideKiqq", wake).build())
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    companion object {
        private const val TAG = "SideKiqqGlassesSvc"
        private const val NOTIFICATION_ID = 42
        const val ACTION_WAKE = "com.sidekiqq.phone.glasses.WAKE"
        const val ACTION_STOP = "com.sidekiqq.phone.glasses.STOP"

        private val _state = MutableStateFlow(GlassesState())
        val state: StateFlow<GlassesState> = _state.asStateFlow()

        /** Starts the session (foreground) without listening. */
        fun start(context: Context) =
            ContextCompat.startForegroundService(context, Intent(context, GlassesSessionService::class.java))

        /** "Hey SideKiqq": start the session if needed and listen once. Call from a user gesture. */
        fun wake(context: Context) =
            ContextCompat.startForegroundService(
                context, Intent(context, GlassesSessionService::class.java).setAction(ACTION_WAKE)
            )

        fun stop(context: Context) {
            context.startService(Intent(context, GlassesSessionService::class.java).setAction(ACTION_STOP))
        }

        fun hasMicPermission(context: Context) =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    }
}
