package com.sidekiqq.phone

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.sidekiqq.phone.voice.Speaker
import com.sidekiqq.phone.wear.WearRelay
import com.sidekiqq.shared.SideKiqqClient
import com.sidekiqq.shared.TokenStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/** Process-wide singletons. Kept deliberately small (no DI framework). */
class SideKiqqApp : Application() {

    /** Long-lived scope for fire-and-forget work (FCM token registration, wear relay). */
    val appScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val tokenStore: TokenStore by lazy { TokenStore(this) }
    val wearRelay: WearRelay by lazy { WearRelay(this) }

    /** Phone-side TTS: plays on the active media route (A2DP glasses / earbuds when connected). */
    val speaker: Speaker by lazy { Speaker(this) }

    /** How many MainActivity instances are STARTED (multi-window can briefly have two). */
    private val handoffScreens = java.util.concurrent.atomic.AtomicInteger(0)

    /**
     * True while a MainActivity is STARTED (its hand-off poll loop is running). FCM command nudges
     * then poll right away instead of posting a notification.
     */
    val handoffsVisible: Boolean get() = handoffScreens.get() > 0

    fun onHandoffScreenStarted() { handoffScreens.incrementAndGet() }

    fun onHandoffScreenStopped() { handoffScreens.updateAndGet { if (it > 0) it - 1 else 0 } }

    private val _commandNudges = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Emits when an FCM `kind: "command"` nudge arrives while the app is visible. */
    val commandNudges: SharedFlow<Unit> = _commandNudges.asSharedFlow()

    fun onCommandNudge() {
        _commandNudges.tryEmit(Unit)
    }

    @Volatile private var cachedClient: Pair<String, SideKiqqClient>? = null

    /** Client for the currently configured server, or null if not paired yet. Rebuilt if the URL changes. */
    fun client(): SideKiqqClient? {
        val url = tokenStore.baseUrl?.takeIf { it.isNotBlank() } ?: return null
        cachedClient?.let { (u, c) -> if (u == url) return c }
        synchronized(this) {
            cachedClient?.let { (u, c) -> if (u == url) return c else c.close() }
            val c = SideKiqqClient(url, tokenStore::token)
            cachedClient = url to c
            return c
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannels()
    }

    private fun createChannels() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_ALERTS, getString(R.string.channel_alerts), NotificationManager.IMPORTANCE_HIGH)
                    .apply { description = getString(R.string.channel_alerts_desc) },
                NotificationChannel(CHANNEL_HANDOFFS, getString(R.string.channel_handoffs), NotificationManager.IMPORTANCE_HIGH)
                    .apply { description = getString(R.string.channel_handoffs_desc) },
                NotificationChannel(CHANNEL_REPLIES, getString(R.string.channel_replies), NotificationManager.IMPORTANCE_DEFAULT)
                    .apply { description = getString(R.string.channel_replies_desc) },
                NotificationChannel(CHANNEL_CONNECTION, getString(R.string.channel_connection), NotificationManager.IMPORTANCE_LOW)
                    .apply { description = getString(R.string.channel_connection_desc); setShowBadge(false) },
            )
        )
    }

    companion object {
        const val CHANNEL_ALERTS = "alerts"         // must match manifest default_notification_channel_id
        const val CHANNEL_REPLIES = "replies"
        const val CHANNEL_HANDOFFS = "handoffs"
        const val CHANNEL_CONNECTION = "connection"
    }
}

val android.content.Context.sideKiqqApp: SideKiqqApp get() = applicationContext as SideKiqqApp
