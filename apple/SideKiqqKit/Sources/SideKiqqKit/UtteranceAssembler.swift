import Foundation

/**
 * Reassembles one medallion utterance from AUDIO notifications delimited by CONTROL 0x01 / 0x02.
 * Port of android/phone UtteranceAssembler.kt with the same rules:
 *
 * Each AUDIO payload starts with a uint8 counter that wraps 255 -> 0.
 *  - in order: append
 *  - duplicate (counter equal to the previous one): dropped
 *  - forward gap of 1...`maxPaddedGap` packets: pad with silence the size of the missing packets
 *    (assuming the last packet's length) so timing stays intact, and count the gap
 *  - larger gap: not padded, but counted and flagged; continue from the new counter
 *  - a jump of more than 128 forward is treated as a backwards (late/reordered) packet: dropped and flagged
 * The first packet after `start()` sets the baseline whatever its counter is.
 */
public struct UtteranceAssembler: Sendable {
    public struct Stats: Equatable, Sendable {
        public var packets: Int
        public var gaps: Int
        public var missingPackets: Int
        public var duplicates: Int
        public var outOfOrder: Int
        public var truncated: Bool

        public var degraded: Bool { gaps > 0 || outOfOrder > 0 || truncated }

        /** Human-readable warning when degraded (shown in the medallion panel), else nil. */
        public var warning: String? {
            guard degraded else { return nil }
            return "Audio gaps: \(gaps) gap(s), \(missingPackets) lost, \(outOfOrder) late" + (truncated ? ", truncated" : "")
        }
    }

    public struct Utterance: Equatable, Sendable {
        public var pcm: Data
        public var stats: Stats
        public var durationMs: Int64 { WavEncoder.durationMs(pcmBytes: pcm.count) }
    }

    public let maxPaddedGap: Int
    public let maxBytes: Int

    private var buf = PCMBuffer()
    private var lastSeq = -1
    private var lastLen = 0
    private var packets = 0
    private var gaps = 0
    private var missing = 0
    private var dups = 0
    private var ooo = 0
    private var truncated = false

    public private(set) var isActive = false

    /** Defaults: pad gaps of up to 8 packets; cap one utterance at 30 s of 16 kHz PCM16. */
    public init(maxPaddedGap: Int = 8, maxBytes: Int = WavEncoder.sampleRate * 2 * 30) {
        self.maxPaddedGap = maxPaddedGap
        self.maxBytes = maxBytes
    }

    public mutating func start() {
        reset()
        isActive = true
    }

    public mutating func cancel() {
        reset()
        isActive = false
    }

    /** Feed one raw AUDIO notification (including the seq byte). Ignored when not active. */
    public mutating func onAudio(_ packet: Data) {
        let bytes = [UInt8](packet)
        guard isActive, bytes.count >= 2 else { return }
        let seq = Int(bytes[0])
        let payloadLen = bytes.count - 1

        if lastSeq >= 0 {
            let delta = (seq - lastSeq + 256) % 256
            if delta == 0 {
                dups += 1
                return
            } else if delta == 1 {
                // in order
            } else if delta >= 2 && delta <= maxPaddedGap + 1 {
                let lost = delta - 1
                gaps += 1
                missing += lost
                appendSilenceBounded(lost * (lastLen > 0 ? lastLen : payloadLen))
            } else if delta > 128 {
                // A large forward jump is indistinguishable from a late packet; treat as backwards.
                ooo += 1
                return
            } else {
                // Too big to pad sensibly: keep going from here but flag it.
                gaps += 1
                missing += delta - 1
            }
        }
        lastSeq = seq
        lastLen = payloadLen
        packets += 1
        appendBounded(bytes[1...])
    }

    /** Ends the utterance and returns it; nil if not active. */
    public mutating func finish() -> Utterance? {
        guard isActive else { return nil }
        isActive = false
        let result = Utterance(pcm: buf.data, stats: Stats(packets: packets, gaps: gaps, missingPackets: missing,
                                                           duplicates: dups, outOfOrder: ooo, truncated: truncated))
        reset()
        return result
    }

    private mutating func appendBounded(_ src: ArraySlice<UInt8>) {
        let room = maxBytes - buf.count
        if room <= 0 { truncated = true; return }
        let n = min(src.count, room)
        if n < src.count { truncated = true }
        buf.append(contentsOf: src.prefix(n))
    }

    private mutating func appendSilenceBounded(_ len: Int) {
        let room = maxBytes - buf.count
        if room <= 0 { truncated = true; return }
        let n = min(len, room)
        if n < len { truncated = true }
        buf.appendSilence(byteCount: n)
    }

    private mutating func reset() {
        buf.reset()
        lastSeq = -1
        lastLen = 0
        packets = 0; gaps = 0; missing = 0; dups = 0; ooo = 0
        truncated = false
    }
}
