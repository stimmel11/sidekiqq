package com.sidekiqq.phone.reachy

import java.io.Closeable

/**
 * "Find Reachy" (start up Reachy, slice 3): look for Reachy Mini daemons on the home Wi-Fi so the
 * owner doesn't have to type `reachy-mini.local`.
 *
 * The daemon advertises `_reachy-mini._tcp.local.` over mDNS (reachy_mini 1.12
 * `utils/discovery.py`): PTR → `<robot_name>._reachy-mini._tcp.local.`, SRV → `<hostname>.local.`
 * and the FastAPI port, TXT with `robot_name`. We ask with legacy-unicast queries ([MdnsWire.query])
 * and keep only the SRV target name and port.
 *
 * Safety:
 * - Any device on the Wi-Fi can answer, so a result is only a suggestion: it is shown to the owner
 *   and saved only when they tap it, and it still has to pass [ReachyLan.parseHost] (a `.local`
 *   name, never an IP address), the same rule as a typed address. The daemon still gets no token.
 * - Nothing is saved or started by discovery itself; it sends nothing but mDNS questions (2 PTR,
 *   at most 5 SRV).
 * - Bounded: one search lasts [timeoutMs], asks for at most [MAX_SRV_QUERIES] instances and returns
 *   at most [MAX_RESULTS] robots.
 */
data class FoundReachy(
    /** Cleaned `robot_name` from TXT (or the instance name), for the list only; never sent anywhere. */
    val name: String,
    val host: ReachyHost,
)

/** Sends and receives raw mDNS packets. [MdnsUdp] is the real one; tests use a fake. */
interface MdnsTransport : Closeable {
    fun send(packet: ByteArray)

    /** The next packet that arrives within [timeoutMs] (> 0), or null on timeout. */
    fun receive(timeoutMs: Long): ByteArray?
}

class ReachyFinder(
    private val transport: MdnsTransport,
    private val now: () -> Long,
    private val nextId: () -> Int,
    private val timeoutMs: Long = 3_000,
) {
    /** Blocking; call off the main thread. Throws only what [transport] throws on send. */
    fun find(): List<FoundReachy> {
        val records = ArrayList<MdnsWire.Record>()
        val ids = HashSet<Int>()
        val asked = ArrayList<MdnsWire.Name>()
        fun ask(name: MdnsWire.Name, type: Int) {
            val id = nextId() and 0xffff
            ids += id
            transport.send(MdnsWire.query(id, name, type))
        }

        val start = now()
        val deadline = start + timeoutMs
        ask(SERVICE, MdnsWire.TYPE_PTR)
        var resent = false
        while (true) {
            val t = now()
            if (t >= deadline) break
            // One repeat of the PTR question, in case the first one was lost on Wi-Fi.
            if (!resent && t - start >= RESEND_AFTER_MS) { resent = true; ask(SERVICE, MdnsWire.TYPE_PTR) }
            val wait = if (resent) deadline - t else minOf(deadline, start + RESEND_AFTER_MS) - t
            val packet = transport.receive(maxOf(1, wait)) ?: continue
            if (packet.size > MdnsWire.MAX_PACKET) continue
            val msg = MdnsWire.parse(packet) ?: continue
            // Legacy unicast answers echo our query id (RFC 6762 §6.7); drop anything else.
            if (!msg.isResponse || msg.id !in ids) continue
            for (r in msg.records) if (records.size < MAX_RECORDS) records += r
            // An instance seen without its SRV: ask for it directly.
            for (instance in instances(records)) {
                if (asked.size >= MAX_SRV_QUERIES) break
                if (asked.any { it.sameAs(instance) } || srvFor(records, instance) != null) continue
                asked += instance
                try { ask(instance, MdnsWire.TYPE_SRV) } catch (_: IllegalArgumentException) { /* unencodable name: skip */ }
            }
        }
        return candidates(records)
    }

    companion object {
        val SERVICE: MdnsWire.Name = MdnsWire.Name.of("_reachy-mini._tcp.local")
        const val MAX_RESULTS = 8
        const val MAX_SRV_QUERIES = 5
        private const val MAX_RECORDS = 256
        private const val RESEND_AFTER_MS = 1_000L
        private const val MAX_NAME_CHARS = 32

        /** Instance names from live PTR records for the service: exactly one label under it. */
        fun instances(records: List<MdnsWire.Record>): List<MdnsWire.Name> {
            val out = ArrayList<MdnsWire.Name>()
            for (r in records) {
                val d = r.data as? MdnsWire.Rdata.Ptr ?: continue
                if (r.ttl == 0L || !r.name.sameAs(SERVICE)) continue // ttl 0 = goodbye
                val t = d.target
                if (t.labels.size != SERVICE.labels.size + 1) continue
                if (!MdnsWire.Name(t.labels.drop(1)).sameAs(SERVICE)) continue
                // Invalid UTF-8 decodes to U+FFFD and would no longer fit a label when we ask for its SRV.
                if (t.labels[0].toByteArray(Charsets.UTF_8).size !in 1..63) continue
                if (out.none { it.sameAs(t) }) out += t
            }
            return out
        }

        private fun srvFor(records: List<MdnsWire.Record>, instance: MdnsWire.Name): MdnsWire.Rdata.Srv? =
            records.firstOrNull { it.ttl > 0 && it.name.sameAs(instance) && it.data is MdnsWire.Rdata.Srv }?.data as MdnsWire.Rdata.Srv?

        private fun txtFor(records: List<MdnsWire.Record>, instance: MdnsWire.Name): Map<String, String> =
            (records.firstOrNull { it.ttl > 0 && it.name.sameAs(instance) && it.data is MdnsWire.Rdata.Txt }?.data as MdnsWire.Rdata.Txt?)
                ?.entries.orEmpty()

        /** Robots we can offer: instance → SRV → a `.local` host that [ReachyLan.parseHost] accepts. */
        fun candidates(records: List<MdnsWire.Record>): List<FoundReachy> {
            val out = ArrayList<FoundReachy>()
            for (instance in instances(records)) {
                if (out.size >= MAX_RESULTS) break
                val srv = srvFor(records, instance) ?: continue
                if (srv.port == 0 || srv.target.labels.isEmpty()) continue
                val host = ReachyLan.parseHost("${srv.target}:${srv.port}") ?: continue
                if (out.any { it.host.display == host.display }) continue
                val name = cleanName(txtFor(records, instance)["robot_name"])
                    ?: cleanName(instance.labels.first())
                    ?: host.host
                out += FoundReachy(name, host)
            }
            return out
        }

        /** Letters, digits, space, `-` and `_` only, at most 32 characters; null if nothing is left. */
        fun cleanName(raw: String?): String? {
            if (raw == null) return null
            val s = raw.filter { it.isLetterOrDigit() || it == ' ' || it == '-' || it == '_' }
                .trim().replace(Regex(" {2,}"), " ").take(MAX_NAME_CHARS).trim()
            return s.ifEmpty { null }
        }
    }
}
