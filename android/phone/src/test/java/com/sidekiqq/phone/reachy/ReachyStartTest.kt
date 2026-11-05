package com.sidekiqq.phone.reachy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.coroutines.Continuation
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine

/** Pure-JVM tests: no coroutines library needed, since nothing here really suspends. */
class ReachyStartTest {

    private fun <T> run(block: suspend () -> T): T {
        var out: Result<T>? = null
        block.startCoroutine(Continuation(EmptyCoroutineContext) { out = it })
        return out!!.getOrThrow()
    }

    /** Replays [statuses] (the last one repeats). Each item is a DaemonApp, null, or an exception to throw. */
    private class FakeDaemon(private val statuses: List<Any?>, private val startError: Exception? = null) : ReachyDaemon {
        var polls = 0
        val starts = mutableListOf<String>()
        override suspend fun currentApp(): DaemonApp? {
            val s = statuses[minOf(polls, statuses.size - 1)]
            polls++
            if (s is Exception) throw s
            return s as DaemonApp?
        }
        override suspend fun startApp(name: String) {
            starts += name
            startError?.let { throw it }
        }
    }

    private class Clock {
        var t = 0L
        val sleeps = mutableListOf<Long>()
    }

    private fun starter(d: ReachyDaemon, clock: Clock, wakes: MutableList<String>, wakeError: Exception? = null) =
        ReachyStarter(
            daemon = d,
            queueWake = { a -> wakeError?.let { throw it }; wakes += a },
            sleep = { ms -> clock.sleeps += ms; clock.t += ms },
            now = { clock.t },
            pollMs = 1_000,
            timeoutMs = 10_000,
        )

    private val ours = ReachyLan.APP_NAME
    private fun app(state: String, name: String = ours) = DaemonApp(name, state)

    // ---------------------------------------------------------------- host parsing

    @Test
    fun parsesLocalNamesAndPorts() {
        assertEquals("http://reachy-mini.local:8000", ReachyLan.parseHost("reachy-mini.local")!!.baseUrl)
        assertEquals("http://reachy-mini.local:8000", ReachyLan.parseHost("  Reachy-Mini.LOCAL  ")!!.baseUrl)
        assertEquals("http://desk.local:8080", ReachyLan.parseHost("http://desk.local:8080/")!!.baseUrl)
        assertEquals("desk.local:8080", ReachyLan.parseHost("desk.local:8080")!!.display)
        assertEquals("reachy-mini.local", ReachyLan.parseHost("reachy-mini.local:8000")!!.display)
        assertEquals("http://a.b.local:8000", ReachyLan.parseHost("a.b.local")!!.baseUrl)
    }

    @Test
    fun refusesAnythingThatIsNotALocalName() {
        listOf(
            "", "local", ".local", "reachy-mini", "example.com", "reachy.local.example.com",
            "192.168.1.20", "192.168.1.20:8000", "10.0.0.5", "[::1]:8000",
            "https://reachy-mini.local", "ftp://reachy-mini.local",
            "reachy-mini.local/api", "reachy-mini.local?x=1", "reachy-mini.local#a",
            "user@reachy-mini.local", "user:pw@reachy-mini.local",
            "reachy-mini.local:", "reachy-mini.local:0", "reachy-mini.local:65536", "reachy-mini.local:80a",
            "reachy-mini.local:8000:1", "-bad.local", "bad-.local", "re achy.local", "reachy_mini.local",
            "reachy-mini.local\\", "a..local",
        ).forEach { assertNull("should refuse '$it'", ReachyLan.parseHost(it)) }
    }

    // ---------------------------------------------------------------- step decision

    @Test
    fun stepsFollowTheDaemonState() {
        assertEquals(StartStep.Start, ReachyLan.stepFor(null))
        assertEquals(StartStep.Start, ReachyLan.stepFor(app(DaemonAppState.DONE)))
        assertEquals(StartStep.Start, ReachyLan.stepFor(app(DaemonAppState.DONE, name = "other_app")))
        assertEquals(StartStep.Ready, ReachyLan.stepFor(app(DaemonAppState.RUNNING)))
        assertEquals(StartStep.Wait, ReachyLan.stepFor(app(DaemonAppState.STARTING)))
        assertEquals(StartStep.Stopping, ReachyLan.stepFor(app(DaemonAppState.STOPPING)))
        assertEquals(StartStep.Wait, ReachyLan.stepFor(app("paused")))
        assertEquals(StartStep.AppError, ReachyLan.stepFor(app(DaemonAppState.ERROR)))
        assertEquals(StartStep.Busy("other_app"), ReachyLan.stepFor(app(DaemonAppState.RUNNING, name = "other_app")))
        assertEquals(StartStep.Busy("other_app"), ReachyLan.stepFor(app(DaemonAppState.STARTING, name = "other_app")))
        assertEquals(StartStep.Busy("other_app"), ReachyLan.stepFor(app(DaemonAppState.ERROR, name = "other_app")))
        assertEquals(StartStep.Wait, ReachyLan.stepFor(app(DaemonAppState.STOPPING, name = "other_app")))
    }

    // ---------------------------------------------------------------- flow

    @Test
    fun alreadyRunningJustQueuesTheWake() {
        val d = FakeDaemon(listOf(app(DaemonAppState.RUNNING)))
        val wakes = mutableListOf<String>()
        val out = run { starter(d, Clock(), wakes).start("dance") }
        assertEquals(StartOutcome.Woken("dance", wasRunning = true), out)
        assertTrue(d.starts.isEmpty())
        assertEquals(listOf("dance"), wakes)
    }

    @Test
    fun startsTheAppWaitsUntilRunningThenWakes() {
        val d = FakeDaemon(listOf(null, app(DaemonAppState.STARTING), app(DaemonAppState.STARTING), app(DaemonAppState.RUNNING)))
        val clock = Clock()
        val wakes = mutableListOf<String>()
        val out = run { starter(d, clock, wakes).start("chat") }
        assertEquals(StartOutcome.Woken("chat", wasRunning = false), out)
        assertEquals(listOf(ours), d.starts)
        assertEquals(listOf("chat"), wakes)
        // Three polls, then the settle wait and one more check before waking.
        assertEquals(listOf(1_000L, 1_000L, 1_000L, 3_000L), clock.sleeps)
        assertEquals(5, d.polls)
    }

    @Test
    fun appThatCrashesRightAfterRunningIsAnErrorNotAWake() {
        val d = FakeDaemon(listOf(null, app(DaemonAppState.RUNNING), app(DaemonAppState.ERROR)))
        val wakes = mutableListOf<String>()
        assertEquals(StartOutcome.AppError, run { starter(d, Clock(), wakes).start("chat") })
        assertTrue(wakes.isEmpty())
    }

    @Test
    fun ourAppBeingStoppedIsNotRestarted() {
        val d = FakeDaemon(listOf(app(DaemonAppState.STOPPING), null))
        val wakes = mutableListOf<String>()
        assertEquals(StartOutcome.Stopping, run { starter(d, Clock(), wakes).start("chat") })
        assertTrue(d.starts.isEmpty())
        assertTrue(wakes.isEmpty())
    }

    @Test
    fun anotherAppIsNeverStopped() {
        val d = FakeDaemon(listOf(app(DaemonAppState.RUNNING, name = "conversation_app")))
        val wakes = mutableListOf<String>()
        assertEquals(StartOutcome.Busy("conversation_app"), run { starter(d, Clock(), wakes).start("chat") })
        assertTrue(d.starts.isEmpty())
        assertTrue(wakes.isEmpty())
    }

    @Test
    fun anotherAppStoppingIsWaitedOutThenOursStarts() {
        val d = FakeDaemon(listOf(app(DaemonAppState.STOPPING, name = "x"), app(DaemonAppState.DONE, name = "x"), app(DaemonAppState.RUNNING)))
        val wakes = mutableListOf<String>()
        assertEquals(StartOutcome.Woken("brief", wasRunning = false), run { starter(d, Clock(), wakes).start("brief") })
        assertEquals(listOf(ours), d.starts)
    }

    @Test
    fun ourAppInErrorIsReportedNotRestarted() {
        val d = FakeDaemon(listOf(app(DaemonAppState.ERROR)))
        val wakes = mutableListOf<String>()
        assertEquals(StartOutcome.AppError, run { starter(d, Clock(), wakes).start("chat") })
        assertTrue(d.starts.isEmpty())
        assertTrue(wakes.isEmpty())
    }

    @Test
    fun appThatExitsAfterStartIsNotStartedTwice() {
        val d = FakeDaemon(listOf(null, app(DaemonAppState.STARTING), app(DaemonAppState.DONE)))
        val wakes = mutableListOf<String>()
        assertEquals(StartOutcome.Exited, run { starter(d, Clock(), wakes).start("chat") })
        assertEquals(1, d.starts.size)
        assertTrue(wakes.isEmpty())
    }

    @Test
    fun startingForeverTimesOut() {
        val d = FakeDaemon(listOf(null, app(DaemonAppState.STARTING)))
        val clock = Clock()
        val wakes = mutableListOf<String>()
        assertEquals(StartOutcome.TimedOut, run { starter(d, clock, wakes).start("chat") })
        assertTrue(clock.t in 10_000L..11_000L)
        assertTrue(wakes.isEmpty())
    }

    @Test
    fun unreachableAndRefused() {
        val wakes = mutableListOf<String>()
        val down = FakeDaemon(listOf(ReachyDaemonException.Unreachable("no route")))
        assertEquals(StartOutcome.Unreachable, run { starter(down, Clock(), wakes).start("chat") })

        val refused = FakeDaemon(listOf(null), startError = ReachyDaemonException.Refused(400, "The robot app slot is already in use"))
        assertEquals(StartOutcome.Refused("The robot app slot is already in use"), run { starter(refused, Clock(), wakes).start("chat") })

        val dropped = FakeDaemon(listOf(null, ReachyDaemonException.Unreachable("reset")))
        assertEquals(StartOutcome.Unreachable, run { starter(dropped, Clock(), wakes).start("chat") })
        assertTrue(wakes.isEmpty())
    }

    @Test
    fun brainFailureAfterStartIsReported() {
        val d = FakeDaemon(listOf(app(DaemonAppState.RUNNING)))
        val out = run { starter(d, Clock(), mutableListOf(), wakeError = IllegalStateException("no Reachy is paired with SideKiqq")).start("chat") }
        assertEquals(StartOutcome.WakeNotQueued("no Reachy is paired with SideKiqq"), out)
        assertTrue(out.message().contains("no Reachy is paired"))
    }

    @Test
    fun onlyOfferedActivitiesRun() {
        val d = FakeDaemon(listOf(null))
        val wakes = mutableListOf<String>()
        listOf("game", "", "CHAT", "dance; rm").forEach {
            assertEquals(StartOutcome.BadActivity, run { starter(d, Clock(), wakes).start(it) })
        }
        assertEquals(0, d.polls)
        assertTrue(d.starts.isEmpty())
    }

    @Test
    fun messagesAreShortAndSpecific() {
        assertEquals("Reachy started. It will wake up to dance within about 30 seconds.", StartOutcome.Woken("dance", false).message())
        assertEquals("Reachy is on. It will wake up with your brief within about 30 seconds.", StartOutcome.Woken("brief", true).message())
        assertTrue(StartOutcome.Busy("other").message().contains("other"))
    }
}
