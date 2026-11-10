package com.sidekiqq.phone.reachy

/**
 * The few bits of DNS wire format that "Find Reachy" needs (RFC 1035 / RFC 6762), pure Kotlin so it
 * is unit-tested on the JVM.
 *
 * Packets come from anyone on the Wi-Fi, so the parser is defensive: every read is bounds-checked,
 * compression pointers must point strictly backwards (no loops), names are capped at 255 bytes, and
 * a packet that breaks any rule is dropped whole ([parse] returns null). It never throws.
 */
object MdnsWire {
    const val TYPE_A = 1
    const val TYPE_PTR = 12
    const val TYPE_TXT = 16
    const val TYPE_SRV = 33
    private const val CLASS_IN = 1

    /** Bigger than any sane mDNS answer (RFC 6762 §17 allows up to 9000 bytes). */
    const val MAX_PACKET = 9000
    private const val MAX_NAME = 255
    private const val MAX_RECORDS = 64

    /** A DNS name as its labels (an instance label may itself contain dots or spaces). */
    data class Name(val labels: List<String>) {
        fun sameAs(other: Name): Boolean =
            labels.size == other.labels.size && labels.indices.all { labels[it].equals(other.labels[it], ignoreCase = true) }

        override fun toString() = labels.joinToString(".")

        companion object {
            fun of(dotted: String) = Name(dotted.trimEnd('.').split('.'))
        }
    }

    sealed interface Rdata {
        data class Ptr(val target: Name) : Rdata
        data class Srv(val priority: Int, val weight: Int, val port: Int, val target: Name) : Rdata
        data class Txt(val entries: Map<String, String>) : Rdata
        data class A(val address: String) : Rdata
    }

    data class Record(val name: Name, val type: Int, val ttl: Long, val data: Rdata)

    data class Message(val id: Int, val isResponse: Boolean, val records: List<Record>)

    /**
     * One question, sent from an ephemeral port: a "legacy unicast" query (RFC 6762 §6.7), so
     * responders answer straight to our socket and the phone doesn't need to join the multicast
     * group or hold a Wi-Fi multicast lock.
     */
    fun query(id: Int, name: Name, type: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        fun u16(v: Int) { out.write((v ushr 8) and 0xff); out.write(v and 0xff) }
        u16(id and 0xffff); u16(0); u16(1); u16(0); u16(0); u16(0)
        for (label in name.labels) {
            val b = label.toByteArray(Charsets.UTF_8)
            require(b.size in 1..63) { "bad label" }
            out.write(b.size); out.write(b)
        }
        out.write(0)
        u16(type); u16(CLASS_IN)
        return out.toByteArray()
    }

    /** Answer, authority and additional records of [packet] that we understand; null if malformed. */
    fun parse(packet: ByteArray): Message? = try {
        Reader(packet).message()
    } catch (_: Malformed) {
        null
    }

    private class Malformed : Exception() {
        override fun fillInStackTrace(): Throwable = this
    }

    private class Reader(private val b: ByteArray) {
        private var pos = 0

        fun message(): Message {
            if (b.size < 12 || b.size > MAX_PACKET) throw Malformed()
            val id = u16()
            val flags = u16()
            val qd = u16(); val an = u16(); val ns = u16(); val ar = u16()
            if (qd > 16) throw Malformed()
            repeat(qd) { name(); need(4); pos += 4 }
            val total = an + ns + ar
            val records = ArrayList<Record>()
            for (i in 0 until total) {
                if (pos == b.size) break // truncated counts: keep what we have
                val owner = name()
                val type = u16()
                val cls = u16() and 0x7fff // top bit is mDNS cache-flush
                val ttl = u32()
                val len = u16()
                need(len)
                val end = pos + len
                val data = if (cls != CLASS_IN) null else when (type) {
                    TYPE_PTR -> Rdata.Ptr(name())
                    TYPE_SRV -> { need(6); Rdata.Srv(u16(), u16(), u16(), name()) }
                    TYPE_TXT -> Rdata.Txt(txt(end))
                    TYPE_A -> if (len == 4) Rdata.A((0 until 4).joinToString(".") { (b[pos + it].toInt() and 0xff).toString() }) else null
                    else -> null
                }
                if (data != null && type != TYPE_TXT && type != TYPE_A && pos != end) throw Malformed() // rdata length lies
                pos = end
                if (data != null && records.size < MAX_RECORDS) records += Record(owner, type, ttl, data)
            }
            return Message(id, isResponse = (flags and 0x8000) != 0, records = records)
        }

        private fun need(n: Int) { if (n < 0 || pos + n > b.size) throw Malformed() }
        private fun u8(): Int { need(1); return b[pos++].toInt() and 0xff }
        private fun u16(): Int = (u8() shl 8) or u8()
        private fun u32(): Long = (u16().toLong() shl 16) or u16().toLong()

        /** Reads a name at [pos], following compression pointers that only point backwards. */
        fun name(): Name {
            val labels = ArrayList<String>()
            var p = pos
            var jumped = false
            var lowest = pos // a pointer must land strictly before every place we've read from
            var bytes = 0
            while (true) {
                if (p >= b.size) throw Malformed()
                val len = b[p].toInt() and 0xff
                when {
                    len == 0 -> { if (!jumped) pos = p + 1; break }
                    (len and 0xc0) == 0xc0 -> {
                        if (p + 1 >= b.size) throw Malformed()
                        val target = ((len and 0x3f) shl 8) or (b[p + 1].toInt() and 0xff)
                        if (target >= lowest) throw Malformed()
                        if (!jumped) pos = p + 2
                        jumped = true
                        lowest = target
                        p = target
                    }
                    (len and 0xc0) != 0 -> throw Malformed() // reserved label types
                    else -> {
                        if (p + 1 + len > b.size) throw Malformed()
                        bytes += len + 1
                        if (bytes > MAX_NAME) throw Malformed()
                        labels += String(b, p + 1, len, Charsets.UTF_8)
                        p += 1 + len
                    }
                }
            }
            return Name(labels)
        }

        private fun txt(end: Int): Map<String, String> {
            val out = LinkedHashMap<String, String>()
            while (pos < end) {
                val len = u8()
                if (pos + len > end) throw Malformed()
                val s = String(b, pos, len, Charsets.UTF_8)
                pos += len
                val eq = s.indexOf('=')
                val key = (if (eq < 0) s else s.substring(0, eq)).lowercase()
                // RFC 6763 §6.4: only the first occurrence of a key counts.
                if (key.isNotEmpty() && key !in out && out.size < 32) out[key] = if (eq < 0) "" else s.substring(eq + 1)
            }
            return out
        }
    }
}
