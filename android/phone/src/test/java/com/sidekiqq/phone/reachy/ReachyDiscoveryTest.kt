package com.sidekiqq.phone.reachy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream

class ReachyDiscoveryTest {

    // ---------------------------------------------------------------- packet builder (tests only)

    private class Pkt(val id: Int = 0, val response: Boolean = true) {
        val out = ByteArrayOutputStream()
        private val body = ByteArrayOutputStream()
        var count = 0

        fun u16(o: ByteArrayOutputStream, v: Int) { o.write((v ushr 8) and 0xff); o.write(v and 0xff) }
        fun u32(o: ByteArrayOutputStream, v: Long) { u16(o, (v ushr 16).toInt()); u16(o, (v and 0xffff).toInt()) }
        fun name(o: ByteArrayOutputStream, dotted: String) {
            for (l in dotted.trimEnd('.').split('.')) { val b = l.toByteArray(); o.write(b.size); o.write(b) }
            o.write(0)
        }

        fun rr(owner: String, type: Int, ttl: Long = 120, cls: Int = 0x8001, rdata: (ByteArrayOutputStream) -> Unit): Pkt {
            name(body, owner); u16(body, type); u16(body, cls); u32(body, ttl)
            val r = ByteArrayOutputStream().also(rdata).toByteArray()
            u16(body, r.size); body.write(r)
            count++
            return this
        }

        fun ptr(owner: String, target: String, ttl: Long = 4500) = rr(owner, MdnsWire.TYPE_PTR, ttl) { name(it, target) }
        fun srv(owner: String, target: String, port: Int, ttl: Long = 120) = rr(owner, MdnsWire.TYPE_SRV, ttl) {
            u16(it, 0); u16(it, 0); u16(it, port); name(it, target)
        }
        fun txt(owner: String, vararg kv: String) = rr(owner, MdnsWire.TYPE_TXT) { o ->
            for (s in kv) { val b = s.toByteArray(); o.write(b.size); o.write(b) }
        }

        fun bytes(questions: Int = 0): ByteArray {
            val o = ByteArrayOutputStream()
            u16(o, id); u16(o, if (response) 0x8400 else 0); u16(o, questions); u16(o, count); u16(o, 0); u16(o, 0)
            repeat(questions) { name(o, SVC); u16(o, 12); u16(o, 1) }
            o.write(body.toByteArray())
            return o.toByteArray()
        }
    }

    private companion object {
        const val SVC = "_reachy-mini._tcp.local"
        const val INST = "reachy_mini._reachy-mini._tcp.local"
    }

    private fun fullAnswer(id: Int) = Pkt(id)
        .ptr(SVC, INST)
        .srv(INST, "reachy-mini.local", 8000)
        .txt(INST, "version=1.12.0", "robot_name=reachy_mini", "address=192.168.1.40")
        .bytes(questions = 1)

    // ---------------------------------------------------------------- MdnsWire

    @Test fun queryIsWellFormed() {
        val q = MdnsWire.query(0x1234, ReachyFinder.SERVICE, MdnsWire.TYPE_PTR)
        assertEquals(0x12, q[0].toInt()); assertEquals(0x34, q[1].toInt())
        assertEquals(0, q[2].toInt()); assertEquals(0, q[3].toInt()) // a query, no flags
        assertEquals(1, q[5].toInt()) // one question
        val msg = MdnsWire.parse(q)!!
        assertEquals(false, msg.isResponse)
        assertTrue(msg.records.isEmpty())
    }

    @Test fun parsesPtrSrvTxtWithCacheFlushBit() {
        val msg = MdnsWire.parse(fullAnswer(7))!!
        assertEquals(7, msg.id)
        assertTrue(msg.isResponse)
        assertEquals(3, msg.records.size)
        val srv = msg.records[1].data as MdnsWire.Rdata.Srv
        assertEquals(8000, srv.port)
        assertEquals("reachy-mini.local", srv.target.toString())
        val txt = msg.records[2].data as MdnsWire.Rdata.Txt
        assertEquals("reachy_mini", txt.entries["robot_name"])
    }

    @Test fun followsBackwardCompressionPointers() {
        // PTR owner written in full at offset 12; the PTR target is "reachy_mini" + pointer to 12.
        val o = ByteArrayOutputStream()
        fun u16(v: Int) { o.write((v ushr 8) and 0xff); o.write(v and 0xff) }
        u16(1); u16(0x8400); u16(0); u16(1); u16(0); u16(0)
        for (l in SVC.split('.')) { o.write(l.length); o.write(l.toByteArray()) }; o.write(0)
        u16(12); u16(1); u16(0); u16(4500)
        val inst = "reachy_mini".toByteArray()
        u16(1 + inst.size + 2); o.write(inst.size); o.write(inst); o.write(0xc0); o.write(12)
        val msg = MdnsWire.parse(o.toByteArray())!!
        assertEquals(INST, (msg.records.single().data as MdnsWire.Rdata.Ptr).target.toString())
    }

    @Test fun rejectsPointerLoopsAndForwardPointers() {
        val o = ByteArrayOutputStream()
        fun u16(v: Int) { o.write((v ushr 8) and 0xff); o.write(v and 0xff) }
        u16(1); u16(0x8400); u16(0); u16(1); u16(0); u16(0)
        o.write(0xc0); o.write(12) // owner name points at itself
        u16(12); u16(1); u16(0); u16(1); u16(0)
        assertNull(MdnsWire.parse(o.toByteArray()))

        val f = ByteArrayOutputStream()
        fun f16(v: Int) { f.write((v ushr 8) and 0xff); f.write(v and 0xff) }
        f16(1); f16(0x8400); f16(0); f16(1); f16(0); f16(0)
        f.write(0xc0); f.write(40) // forward pointer
        f16(12); f16(1); f16(0); f16(1); f16(0)
        repeat(40) { f.write(0) }
        assertNull(MdnsWire.parse(f.toByteArray()))
    }

    @Test fun rejectsTruncatedAndLyingPackets() {
        val good = fullAnswer(1)
        for (cut in listOf(5, 13, 30, good.size - 1)) assertNull("cut at $cut", MdnsWire.parse(good.copyOf(cut)))
        // SRV whose rdlength is longer than its content.
        val lie = Pkt(1).rr(INST, MdnsWire.TYPE_SRV) { o ->
            o.write(0); o.write(0); o.write(0); o.write(0); o.write(0x1f); o.write(0x40); o.write(0); o.write(0); o.write(0)
        }.bytes()
        assertNull(MdnsWire.parse(lie))
        assertNull(MdnsWire.parse(ByteArray(0)))
        assertNull(MdnsWire.parse(ByteArray(MdnsWire.MAX_PACKET + 1)))
    }

    @Test fun rejectsOverlongNames() {
        val long = (1..5).joinToString(".") { "a".repeat(60) } // 305 bytes
        assertNull(MdnsWire.parse(Pkt(1).ptr(SVC, long).bytes()))
    }

    @Test fun parserNeverThrowsOnGarbage() {
        val rnd = java.util.Random(42)
        val base = fullAnswer(3)
        repeat(3000) {
            val b = base.copyOf()
            repeat(1 + rnd.nextInt(6)) { b[rnd.nextInt(b.size)] = rnd.nextInt(256).toByte() }
            MdnsWire.parse(b) // must not throw
            val r = ByteArray(rnd.nextInt(200)).also { rnd.nextBytes(it) }
            MdnsWire.parse(r)
        }
    }

    // ---------------------------------------------------------------- candidates

    @Test fun candidateFromFullAnswer() {
        val found = ReachyFinder.candidates(MdnsWire.parse(fullAnswer(1))!!.records)
        assertEquals(1, found.size)
        assertEquals("reachy_mini", found[0].name)
        assertEquals("reachy-mini.local", found[0].host.display) // default port shown bare
    }

    @Test fun nonDefaultPortKept() {
        val recs = MdnsWire.parse(Pkt(1).ptr(SVC, INST).srv(INST, "Den-Robot.local", 8042).bytes())!!.records
        assertEquals("den-robot.local:8042", ReachyFinder.candidates(recs).single().host.display)
    }

    @Test fun neverOffersAnIpOrNonLocalHost() {
        for (target in listOf("192.168.1.40", "evil.example.com", "reachy-mini.local.evil.com", "bad_host.local", "localhost")) {
            val recs = MdnsWire.parse(Pkt(1).ptr(SVC, INST).srv(INST, target, 8000).bytes())!!.records
            assertTrue(target, ReachyFinder.candidates(recs).isEmpty())
        }
    }

    @Test fun ignoresGoodbyesOtherServicesAndNestedInstances() {
        val recs = MdnsWire.parse(
            Pkt(1)
                .ptr(SVC, INST, ttl = 0) // goodbye
                .ptr("_http._tcp.local", "printer._http._tcp.local")
                .srv("printer._http._tcp.local", "printer.local", 80)
                .ptr(SVC, "a.b._reachy-mini._tcp.local") // two labels under the service
                .srv("a.b._reachy-mini._tcp.local", "ab.local", 8000)
                .srv(INST, "reachy-mini.local", 8000)
                .bytes()
        )!!.records
        assertTrue(ReachyFinder.candidates(recs).isEmpty())
    }

    @Test fun srvWithZeroTtlOrPortZeroIgnored() {
        val a = MdnsWire.parse(Pkt(1).ptr(SVC, INST).srv(INST, "reachy-mini.local", 8000, ttl = 0).bytes())!!.records
        assertTrue(ReachyFinder.candidates(a).isEmpty())
        val b = MdnsWire.parse(Pkt(1).ptr(SVC, INST).srv(INST, "reachy-mini.local", 0).bytes())!!.records
        assertTrue(ReachyFinder.candidates(b).isEmpty())
    }

    @Test fun dedupesByHostAndCapsResults() {
        var p = Pkt(1)
        for (i in 0 until 20) {
            val inst = "r$i._reachy-mini._tcp.local"
            p = p.ptr(SVC, inst).srv(inst, if (i < 2) "same.local" else "r$i.local", 8000)
        }
        val found = ReachyFinder.candidates(MdnsWire.parse(p.bytes())!!.records)
        assertEquals(ReachyFinder.MAX_RESULTS, found.size)
        assertEquals(found.map { it.host.display }.distinct(), found.map { it.host.display })
    }

    @Test fun cleanNameStripsControlAndMarkup() {
        assertEquals("Kitchen Reachy", ReachyFinder.cleanName("  Kitchen‮  Reachy\n"))
        assertEquals("scriptalert1script", ReachyFinder.cleanName("<script>alert(1)</script>"))
        assertNull(ReachyFinder.cleanName("<>\u0000"))
        assertEquals(32, ReachyFinder.cleanName("x".repeat(100))!!.length)
        // Falls back to the instance label, then to the host.
        val recs = MdnsWire.parse(Pkt(1).ptr(SVC, "‮<>._reachy-mini._tcp.local").srv("‮<>._reachy-mini._tcp.local", "r.local", 8000).bytes())!!.records
        assertEquals("r.local", ReachyFinder.candidates(recs).single().name)
    }

    // ---------------------------------------------------------------- ReachyFinder.find

    /** Fake LAN: a clock, the questions sent, and a responder that answers each question. */
    private class FakeLan(val respond: (MdnsWire.Name, Int, Int) -> List<ByteArray>) : MdnsTransport {
        var clock = 0L
        val sent = mutableListOf<Pair<String, Int>>()
        private val inbox = ArrayDeque<ByteArray>()
        override fun send(packet: ByteArray) {
            // Parse our own question back: header + one name + type.
            val id = ((packet[0].toInt() and 0xff) shl 8) or (packet[1].toInt() and 0xff)
            var p = 12
            val labels = mutableListOf<String>()
            while (packet[p].toInt() != 0) { val l = packet[p].toInt(); labels += String(packet, p + 1, l); p += 1 + l }
            val type = ((packet[p + 1].toInt() and 0xff) shl 8) or (packet[p + 2].toInt() and 0xff)
            sent += labels.joinToString(".") to type
            inbox.addAll(respond(MdnsWire.Name(labels), type, id))
        }
        override fun receive(timeoutMs: Long): ByteArray? {
            clock += 10
            if (inbox.isNotEmpty()) return inbox.removeFirst()
            clock += timeoutMs
            return null
        }
        override fun close() {}
    }

    private fun finder(lan: FakeLan): ReachyFinder {
        var id = 100
        return ReachyFinder(lan, now = { lan.clock }, nextId = { id++ })
    }

    @Test fun findsRobotFromOneAnswer() {
        val lan = FakeLan { _, type, id -> if (type == MdnsWire.TYPE_PTR) listOf(fullAnswer(id)) else emptyList() }
        val found = finder(lan).find()
        assertEquals("reachy-mini.local", found.single().host.display)
        assertEquals(listOf(SVC to 12, SVC to 12), lan.sent) // the PTR question, repeated once, no SRV needed
    }

    @Test fun asksForMissingSrv() {
        val lan = FakeLan { name, type, id ->
            when (type) {
                MdnsWire.TYPE_PTR -> listOf(Pkt(id).ptr(SVC, INST).bytes())
                MdnsWire.TYPE_SRV -> if (name.toString() == INST) listOf(Pkt(id).srv(INST, "reachy-mini.local", 8000).bytes()) else emptyList()
                else -> emptyList()
            }
        }
        val found = finder(lan).find()
        assertEquals("reachy-mini.local", found.single().host.display)
        assertEquals(1, lan.sent.count { it == INST to MdnsWire.TYPE_SRV }) // asked once only
    }

    @Test fun dropsAnswersWithWrongIdOrQueries() {
        val lan = FakeLan { _, _, id -> listOf(fullAnswer(id + 999), Pkt(id, response = false).ptr(SVC, INST).srv(INST, "x.local", 8000).bytes()) }
        assertTrue(finder(lan).find().isEmpty())
    }

    @Test fun boundedSrvQueriesAndTime() {
        val lan = FakeLan { _, type, id ->
            if (type != MdnsWire.TYPE_PTR) emptyList() else {
                var p = Pkt(id)
                for (i in 0 until 30) p = p.ptr(SVC, "r$i._reachy-mini._tcp.local")
                listOf(p.bytes())
            }
        }
        val found = finder(lan).find()
        assertTrue(found.isEmpty())
        assertEquals(ReachyFinder.MAX_SRV_QUERIES, lan.sent.count { it.second == MdnsWire.TYPE_SRV })
        assertTrue(lan.clock in 3_000..3_100)
    }

    @Test fun nothingOnTheLan() {
        val lan = FakeLan { _, _, _ -> emptyList() }
        assertTrue(finder(lan).find().isEmpty())
        assertEquals(2, lan.sent.size)
    }

    @Test fun invalidUtf8InstanceDoesNotAbortTheSearch() {
        // A PTR whose instance label is 63 bytes of 0xFF (decodes to U+FFFD x63, too long to re-encode), plus a real robot.
        val bad = ByteArrayOutputStream()
        fun u16(o: ByteArrayOutputStream, v: Int) { o.write((v ushr 8) and 0xff); o.write(v and 0xff) }
        val lan = FakeLan { _, type, id ->
            if (type != MdnsWire.TYPE_PTR) emptyList() else {
                bad.reset()
                u16(bad, id); u16(bad, 0x8400); u16(bad, 0); u16(bad, 1); u16(bad, 0); u16(bad, 0)
                for (l in SVC.split('.')) { bad.write(l.length); bad.write(l.toByteArray()) }; bad.write(0)
                u16(bad, 12); u16(bad, 1); u16(bad, 0); u16(bad, 4500)
                u16(bad, 1 + 63 + 2); bad.write(63); repeat(63) { bad.write(0xff) }; bad.write(0xc0); bad.write(12)
                listOf(bad.toByteArray(), fullAnswer(id))
            }
        }
        val found = finder(lan).find()
        assertEquals("reachy-mini.local", found.single().host.display)
        assertTrue(lan.sent.none { it.second == MdnsWire.TYPE_SRV })
    }

    @Test fun mdnsUdpOpensAndCloses() {
        // The real transport binds an ephemeral port and times out cleanly with nobody answering.
        val t = MdnsUdp()
        try { assertNull(t.receive(20)) } finally { t.close() }
        assertNotNull(t)
    }
}
