package com.sidekiqq.phone.reachy

import com.sidekiqq.shared.model.ReachyActivity

/**
 * "Start up Reachy and let's do something", phone side (task: start up Reachy, slice 1).
 *
 * The brain can't reach the owner's home LAN, so the phone does it: it asks the Reachy Mini daemon
 * (`http://<host>:8000/api/apps/...`, plain HTTP on the LAN) to start the SideKiqq app, waits until
 * the app is running, then queues a `reachy_wake` command on the brain (`POST /api/commands`). The
 * Reachy app picks the wake up from `GET /api/commands` and offers a chat, the brief or a dance.
 *
 * Pure Kotlin (no android.*, no ktor) so it is unit-tested on the JVM. [ReachyDaemonHttp] is the
 * real daemon client; MainViewModel wires the brain call.
 *
 * Safety:
 * - Runs only from the owner's tap on the phone. That tap is the "user finishes" step for the
 *   `reachy_wake` hand-off (Reachy has no screen).
 * - Only `.local` (mDNS) host names, so the phone never sends this to a host on the internet. The
 *   daemon gets no SideKiqq token or other data: only app status reads and a start-app call.
 * - It never stops or evicts another app or a remote session: if Reachy is busy, it says so.
 * - Nothing here sends a message or approves a draft.
 */
object ReachyLan {
    /** The SideKiqq Reachy app's name on the robot (`[project] name` in reachy/pyproject.toml). */
    const val APP_NAME = "sidekiqq_reachy"
    const val DEFAULT_HOST = "reachy-mini.local"
    const val DEFAULT_PORT = 8000

    /** What the phone may ask Reachy to do. `game` is a stub on the robot, so it isn't offered yet. */
    val ACTIVITIES: List<String> = listOf(ReachyActivity.CHAT, ReachyActivity.BRIEF, ReachyActivity.DANCE)

    private val LABEL = Regex("[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")

    /**
     * Parses what the owner typed: `reachy-mini.local`, `reachy-mini.local:8000` or the same with
     * `http://` in front (one trailing `/` allowed). Returns null for anything else: other schemes,
     * paths, queries, credentials, IP addresses and names that don't end in `.local`.
     */
    fun parseHost(raw: String): ReachyHost? {
        var s = raw.trim().lowercase()
        if (s.startsWith("http://")) s = s.removePrefix("http://")
        s = s.removeSuffix("/")
        if (s.isEmpty() || s.length > 260) return null
        if (s.any { it == '/' || it == '@' || it == '?' || it == '#' || it == '\\' || it.isWhitespace() }) return null
        val colon = s.lastIndexOf(':')
        val host: String
        val port: Int
        if (colon >= 0) {
            host = s.substring(0, colon)
            val p = s.substring(colon + 1)
            if (p.isEmpty() || p.length > 5 || !p.all { it in '0'..'9' }) return null
            port = p.toInt()
            if (port !in 1..65535) return null
        } else {
            host = s
            port = DEFAULT_PORT
        }
        if (host.length > 253 || !host.endsWith(".local")) return null
        val labels = host.split('.')
        if (labels.size < 2 || !labels.all { LABEL.matches(it) }) return null
        return ReachyHost(host, port)
    }

    /** What to do next, given the daemon's current app (null = no app). */
    fun stepFor(app: DaemonApp?): StartStep {
        if (app == null || app.state == DaemonAppState.DONE) return StartStep.Start
        if (app.name != APP_NAME) {
            return if (app.state == DaemonAppState.STOPPING) StartStep.Wait else StartStep.Busy(app.name)
        }
        return when (app.state) {
            DaemonAppState.RUNNING -> StartStep.Ready
            DaemonAppState.ERROR -> StartStep.AppError
            // Someone is stopping it (for example from the dashboard): don't start it again behind them.
            DaemonAppState.STOPPING -> StartStep.Stopping
            else -> StartStep.Wait // starting, or a state newer than this app knows
        }
    }
}

/** A Reachy daemon on the LAN. Build only through [ReachyLan.parseHost] (not a data class, so no `copy()`). */
class ReachyHost internal constructor(val host: String, val port: Int) {
    val baseUrl: String get() = "http://$host:$port"
    /** What the settings field shows (port left out when it is the default). */
    val display: String get() = if (port == ReachyLan.DEFAULT_PORT) host else "$host:$port"
    override fun equals(other: Any?) = other is ReachyHost && other.host == host && other.port == port
    override fun hashCode() = host.hashCode() * 31 + port
    override fun toString() = "ReachyHost($display)"
}

/** `AppState` values from reachy_mini.apps.manager (1.12.0). */
object DaemonAppState {
    const val STARTING = "starting"
    const val RUNNING = "running"
    const val DONE = "done"
    const val STOPPING = "stopping"
    const val ERROR = "error"
}

/** The daemon's `GET /api/apps/current-app-status` (`info.name`, `state`). */
data class DaemonApp(val name: String, val state: String)

sealed interface StartStep {
    data object Ready : StartStep
    data object Start : StartStep
    data object Wait : StartStep
    data class Busy(val otherApp: String) : StartStep
    data object AppError : StartStep
    data object Stopping : StartStep
}

/** Errors from a [ReachyDaemon]. */
sealed class ReachyDaemonException(message: String) : Exception(message) {
    /** Couldn't connect, name didn't resolve, or timed out. */
    class Unreachable(message: String) : ReachyDaemonException(message)
    /** The daemon answered but refused (non-2xx). [detail] is the daemon's text, shortened. */
    class Refused(val status: Int, val detail: String) : ReachyDaemonException("HTTP $status: $detail")
}

/** The two daemon calls the phone makes. Implementations throw [ReachyDaemonException]. */
interface ReachyDaemon {
    suspend fun currentApp(): DaemonApp?
    /** Starts [name]. Must not evict another app or a remote session. */
    suspend fun startApp(name: String)
}

sealed interface StartOutcome {
    /** The app is running and the wake was queued on the brain. */
    data class Woken(val activity: String, val wasRunning: Boolean) : StartOutcome
    data class Busy(val otherApp: String) : StartOutcome
    data object AppError : StartOutcome
    /** Our app is being stopped by someone else; not restarted behind their back. */
    data object Stopping : StartOutcome
    data object Unreachable : StartOutcome
    data class Refused(val detail: String) : StartOutcome
    /** We started it, but it stopped before it was running. */
    data object Exited : StartOutcome
    data object TimedOut : StartOutcome
    /** The app is running, but the brain didn't take the `reachy_wake` command. */
    data class WakeNotQueued(val reason: String) : StartOutcome
    data object BadActivity : StartOutcome
}

/**
 * Starts the SideKiqq app on Reachy (if needed) and queues the wake. [sleep] and [now] are injected
 * (the ViewModel passes `delay` and `SystemClock.elapsedRealtime`).
 */
class ReachyStarter(
    private val daemon: ReachyDaemon,
    private val queueWake: suspend (activity: String) -> Unit,
    private val sleep: suspend (ms: Long) -> Unit,
    private val now: () -> Long,
    private val pollMs: Long = 1_000,
    private val timeoutMs: Long = 45_000,
    /**
     * The daemon reports `running` as soon as the process is spawned, before the app has loaded.
     * After we start it, we wait this long and check once more, so an app that crashes on import
     * shows as an error instead of "Reachy started".
     */
    private val settleMs: Long = 3_000,
) {
    suspend fun start(activity: String): StartOutcome {
        if (activity !in ReachyLan.ACTIVITIES) return StartOutcome.BadActivity
        val deadline = now() + timeoutMs
        var started = false
        var settled = false
        while (true) {
            val app = try {
                daemon.currentApp()
            } catch (e: ReachyDaemonException.Unreachable) {
                return StartOutcome.Unreachable
            } catch (e: ReachyDaemonException.Refused) {
                return StartOutcome.Refused(e.detail)
            }
            when (val step = ReachyLan.stepFor(app)) {
                StartStep.Ready -> {
                    if (!started || settled) break
                    settled = true
                    sleep(settleMs)
                    continue
                }
                is StartStep.Busy -> return StartOutcome.Busy(step.otherApp)
                StartStep.AppError -> return StartOutcome.AppError
                StartStep.Stopping -> return StartOutcome.Stopping
                StartStep.Start -> {
                    if (started) return StartOutcome.Exited
                    try {
                        daemon.startApp(ReachyLan.APP_NAME)
                    } catch (e: ReachyDaemonException.Unreachable) {
                        return StartOutcome.Unreachable
                    } catch (e: ReachyDaemonException.Refused) {
                        return StartOutcome.Refused(e.detail)
                    }
                    started = true
                }
                StartStep.Wait -> Unit
            }
            if (now() >= deadline) return StartOutcome.TimedOut
            sleep(pollMs)
        }
        return try {
            queueWake(activity)
            StartOutcome.Woken(activity, wasRunning = !started)
        } catch (e: Exception) {
            if (e is kotlin.coroutines.cancellation.CancellationException) throw e
            StartOutcome.WakeNotQueued(e.message ?: e::class.simpleName ?: "error")
        }
    }
}

/** Short text for the snackbar. */
fun StartOutcome.message(): String = when (this) {
    is StartOutcome.Woken -> {
        val what = when (activity) {
            ReachyActivity.CHAT -> " to chat"
            ReachyActivity.BRIEF -> " with your brief"
            ReachyActivity.DANCE -> " to dance"
            else -> ""
        }
        (if (wasRunning) "Reachy is on." else "Reachy started.") + " It will wake up$what within about 30 seconds."
    }
    is StartOutcome.Busy -> "Reachy is running another app ($otherApp). Stop it from the Reachy dashboard first."
    StartOutcome.AppError -> "SideKiqq on Reachy stopped with an error. Restart it from the Reachy dashboard."
    StartOutcome.Stopping -> "SideKiqq on Reachy is shutting down. Try again in a moment."
    StartOutcome.Unreachable -> "Can't reach Reachy. Check that the phone is on the same Wi-Fi and the address is right."
    is StartOutcome.Refused -> "Reachy didn't start SideKiqq: $detail"
    StartOutcome.Exited -> "SideKiqq on Reachy stopped right after starting. Check that it is installed and paired."
    StartOutcome.TimedOut -> "Reachy is taking too long to start SideKiqq. Try again in a minute."
    is StartOutcome.WakeNotQueued -> "Reachy is on, but SideKiqq couldn't ask it to wake up ($reason)."
    StartOutcome.BadActivity -> "Reachy can't do that yet."
}
