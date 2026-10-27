package com.sidekiqq.phone.handoff

import com.sidekiqq.shared.model.CallApp
import com.sidekiqq.shared.model.CommandKind
import com.sidekiqq.shared.model.DeviceCommand
import java.net.URI

/**
 * What the phone would do with a device command IF the owner taps it. Pure Kotlin (no android.*)
 * so it is unit-tested on the JVM; [com.sidekiqq.phone.MainActivity] turns a plan into an Intent.
 *
 * Every command is a hand-off (ARCHITECTURE.md › Device commands): nothing here launches anything.
 * The brain already validated the command; the phone checks again (defense in depth) so a bad or
 * newer-than-us command can never become a dial/open intent:
 * - call_contact: `+?` and 3–15 digits only (the brain's normalised form). The phone opens the
 *   dialer with ACTION_DIAL, never ACTION_CALL, so the owner still taps Call.
 * - open_url: https, no credentials or port, host on the same allowlist as the brain.
 */
sealed interface HandoffPlan {
    /** Text for the main button. */
    val actionLabel: String

    /** Open the dialer pre-filled with [number] (ACTION_DIAL with a `tel:` URI). */
    data class Dial(val number: String) : HandoffPlan {
        override val actionLabel get() = "Open dialer"
    }

    /** Open a WhatsApp chat with [number] via `https://wa.me/<digits>`; the owner starts the call there. */
    data class WhatsApp(val number: String) : HandoffPlan {
        val url: String get() = "https://wa.me/" + number.filter { it.isDigit() }
        override val actionLabel get() = "Open WhatsApp"
    }

    /** Open [url] in its app or the browser (ACTION_VIEW). */
    data class Browser(val url: String, val host: String) : HandoffPlan {
        override val actionLabel get() = "Open link"
    }

    /** Shown so the owner can dismiss it, but there is no button that opens anything. */
    data class CantOpen(val reason: String) : HandoffPlan {
        override val actionLabel get() = ""
    }
}

object Handoffs {
    /** Kinds the phone runs. Other kinds (reachy_wake, kinds added later) are not shown or acked here. */
    val PHONE_KINDS: Set<String> = setOf(CommandKind.OPEN_URL, CommandKind.CALL_CONTACT)

    /** Mirrors `OPEN_URL_HOSTS` / `OPEN_URL_DOMAINS` in brain/src/lib/commands/index.ts. Keep in sync. */
    val OPEN_URL_HOSTS: Set<String> = setOf("meet.google.com", "www.kroger.com", "www.kingsoopers.com")
    val OPEN_URL_DOMAINS: Set<String> = setOf("zoom.us")

    private val NUMBER = Regex("\\+?[0-9]{3,15}") // matched against the whole string

    fun isPhoneKind(cmd: DeviceCommand): Boolean = cmd.kind in PHONE_KINDS

    fun planFor(cmd: DeviceCommand): HandoffPlan = when (cmd.kind) {
        CommandKind.CALL_CONTACT -> planCall(cmd)
        CommandKind.OPEN_URL -> planUrl(cmd.url)
        else -> HandoffPlan.CantOpen("This phone app doesn't know how to run this yet.")
    }

    private fun planCall(cmd: DeviceCommand): HandoffPlan {
        val n = cmd.number.orEmpty()
        if (!NUMBER.matches(n)) return HandoffPlan.CantOpen("The number looks wrong, so it won't be dialed.")
        return when (cmd.app ?: CallApp.PHONE) {
            CallApp.PHONE -> HandoffPlan.Dial(n)
            CallApp.WHATSAPP ->
                if (n.startsWith("+")) HandoffPlan.WhatsApp(n)
                else HandoffPlan.CantOpen("WhatsApp needs an international number starting with +.")
            else -> HandoffPlan.CantOpen("This phone app doesn't know that calling app yet.")
        }
    }

    private fun planUrl(raw: String?): HandoffPlan {
        val bad = HandoffPlan.CantOpen("This link isn't on the list of links SideKiqq opens.")
        if (raw.isNullOrBlank()) return bad
        val u = try { URI(raw) } catch (_: Exception) { return bad }
        if (!u.isAbsolute || u.isOpaque) return bad
        if (!"https".equals(u.scheme, ignoreCase = true)) return bad
        // rawAuthority must be exactly the host: no "user@", no ":port", no IPv6/odd forms.
        val host = u.host?.lowercase() ?: return bad
        if (u.rawUserInfo != null || u.port != -1) return bad
        if (!u.rawAuthority.equals(host, ignoreCase = true)) return bad
        val allowed = host in OPEN_URL_HOSTS || OPEN_URL_DOMAINS.any { host == it || host.endsWith(".$it") }
        if (!allowed) return bad
        return HandoffPlan.Browser(u.toASCIIString(), host)
    }
}

/**
 * The phone's view of its command queue. The brain's GET /api/commands list is the source of truth
 * for liveness; this only hides commands the owner already handled on this phone (their ack may
 * still be in flight, or failed and the brain still lists them) and drops kinds the phone doesn't run.
 */
class CommandInbox(private val maxRemembered: Int = 200) {
    private val handled = LinkedHashSet<String>()

    /** Marks [id] handled. Returns false if it already was (a second tap must not open it again). */
    @Synchronized
    fun markHandled(id: String): Boolean {
        if (id in handled) return false
        handled.add(id)
        while (handled.size > maxRemembered) handled.remove(handled.first())
        return true
    }

    @Synchronized
    fun isHandled(id: String): Boolean = id in handled

    /** Commands to show, oldest first as the brain sent them, without duplicate ids. */
    @Synchronized
    fun visible(polled: List<DeviceCommand>): List<DeviceCommand> {
        val seen = HashSet<String>()
        return polled.filter { Handoffs.isPhoneKind(it) && it.id !in handled && seen.add(it.id) }
    }
}
