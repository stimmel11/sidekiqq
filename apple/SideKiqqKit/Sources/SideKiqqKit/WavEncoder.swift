import Foundation

/**
 * Wraps raw little-endian PCM16 samples in a canonical 44-byte RIFF/WAVE header.
 * Defaults match the brain's `/api/transcribe` contract: 16 kHz, mono, 16-bit.
 * Port of android/shared WavEncoder.kt.
 */
public enum WavEncoder {
    public static let sampleRate = 16_000
    public static let channels = 1
    public static let bitsPerSample = 16
    public static let headerSize = 44

    /** Encode PCM16 LE bytes. An odd trailing byte (half a sample) is dropped. */
    public static func encode(pcm: Data, sampleRate: Int = WavEncoder.sampleRate, channels: Int = WavEncoder.channels) -> Data {
        precondition(sampleRate > 0, "sampleRate must be > 0")
        precondition((1...2).contains(channels), "channels must be 1 or 2")
        let blockAlign = channels * WavEncoder.bitsPerSample / 8
        let dataLen = pcm.count - (pcm.count % blockAlign)
        let byteRate = sampleRate * blockAlign

        var out = Data(capacity: WavEncoder.headerSize + dataLen)
        out.append(contentsOf: Array("RIFF".utf8))
        out.appendLE(UInt32(36 + dataLen))
        out.append(contentsOf: Array("WAVE".utf8))
        out.append(contentsOf: Array("fmt ".utf8))
        out.appendLE(UInt32(16)) // PCM fmt chunk size
        out.appendLE(UInt16(1)) // audio format = PCM
        out.appendLE(UInt16(channels))
        out.appendLE(UInt32(sampleRate))
        out.appendLE(UInt32(byteRate))
        out.appendLE(UInt16(blockAlign))
        out.appendLE(UInt16(WavEncoder.bitsPerSample))
        out.append(contentsOf: Array("data".utf8))
        out.appendLE(UInt32(dataLen))
        out.append(pcm.prefix(dataLen))
        return out
    }

    /** Encode Int16 samples (host order) as PCM16 LE. */
    public static func encode(samples: [Int16], sampleRate: Int = WavEncoder.sampleRate, channels: Int = WavEncoder.channels) -> Data {
        encode(pcm: pcm16LE(samples), sampleRate: sampleRate, channels: channels)
    }

    /** Int16 samples to little-endian bytes. */
    public static func pcm16LE(_ samples: [Int16]) -> Data {
        var d = Data(capacity: samples.count * 2)
        for s in samples { d.appendLE(UInt16(bitPattern: s)) }
        return d
    }

    /** Duration in milliseconds of `pcmBytes` PCM16 bytes at the given format. */
    public static func durationMs(pcmBytes: Int, sampleRate: Int = WavEncoder.sampleRate, channels: Int = WavEncoder.channels) -> Int64 {
        Int64(pcmBytes) * 1000 / (Int64(sampleRate) * Int64(channels) * Int64(WavEncoder.bitsPerSample / 8))
    }

    /** Converts float samples in [-1, 1] (AVAudioEngine's native format) to clamped Int16. */
    public static func floatToInt16(_ samples: [Float]) -> [Int16] {
        samples.map { f in
            let c = max(-1, min(1, f.isNaN ? 0 : f))
            return Int16((c * 32767).rounded())
        }
    }
}

/** Growable PCM buffer used while capturing an utterance. Value type; not shared across threads. */
public struct PCMBuffer: Sendable, Equatable {
    public private(set) var data = Data()
    public init() {}
    public var count: Int { data.count }
    public mutating func append(_ bytes: Data) { data.append(bytes) }
    public mutating func append<C: Collection>(contentsOf bytes: C) where C.Element == UInt8 { data.append(contentsOf: bytes) }
    public mutating func appendSilence(byteCount: Int) {
        if byteCount > 0 { data.append(Data(count: byteCount)) }
    }
    public mutating func reset() { data = Data() }
}

extension Data {
    mutating func appendLE(_ v: UInt16) {
        append(UInt8(v & 0xFF))
        append(UInt8(v >> 8))
    }

    mutating func appendLE(_ v: UInt32) {
        append(UInt8(v & 0xFF))
        append(UInt8((v >> 8) & 0xFF))
        append(UInt8((v >> 16) & 0xFF))
        append(UInt8((v >> 24) & 0xFF))
    }
}
