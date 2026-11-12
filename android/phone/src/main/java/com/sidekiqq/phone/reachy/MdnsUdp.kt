package com.sidekiqq.phone.reachy

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketTimeoutException

/**
 * The real [MdnsTransport]: a plain UDP socket on an ephemeral port. Questions go to the mDNS group
 * (224.0.0.251:5353); responders send legacy-unicast answers back to this socket (RFC 6762 §6.7),
 * so no multicast group join, `MulticastSocket` or Wi-Fi multicast lock is needed. Only packets
 * from port 5353 are passed on. Plain java.net, so it also runs on the JVM.
 */
class MdnsUdp : MdnsTransport {
    private val socket = DatagramSocket(InetSocketAddress(0))
    private val group = InetSocketAddress(InetAddress.getByName("224.0.0.251"), 5353)
    private val buf = ByteArray(MdnsWire.MAX_PACKET)

    override fun send(packet: ByteArray) {
        socket.send(DatagramPacket(packet, packet.size, group))
    }

    override fun receive(timeoutMs: Long): ByteArray? {
        socket.soTimeout = timeoutMs.coerceIn(1, 10_000).toInt()
        return try {
            val p = DatagramPacket(buf, buf.size)
            socket.receive(p)
            if (p.port != 5353) null else p.data.copyOfRange(p.offset, p.offset + p.length)
        } catch (_: SocketTimeoutException) {
            null
        }
    }

    override fun close() = socket.close()
}
