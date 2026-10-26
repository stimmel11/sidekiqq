import XCTest
@testable import SideKiqqKit

final class WavEncoderTests: XCTestCase {
    private func u32(_ d: Data, _ at: Int) -> UInt32 {
        let b = [UInt8](d)
        return UInt32(b[at]) | UInt32(b[at + 1]) << 8 | UInt32(b[at + 2]) << 16 | UInt32(b[at + 3]) << 24
    }

    private func u16(_ d: Data, _ at: Int) -> UInt16 {
        let b = [UInt8](d)
        return UInt16(b[at]) | UInt16(b[at + 1]) << 8
    }

    func testHeaderMatchesContract() {
        let pcm = Data([1, 0, 2, 0, 3, 0])
        let wav = WavEncoder.encode(pcm: pcm)
        XCTAssertEqual(wav.count, 44 + 6)
        XCTAssertEqual(String(decoding: wav[0..<4], as: UTF8.self), "RIFF")
        XCTAssertEqual(u32(wav, 4), 36 + 6)
        XCTAssertEqual(String(decoding: wav[8..<12], as: UTF8.self), "WAVE")
        XCTAssertEqual(String(decoding: wav[12..<16], as: UTF8.self), "fmt ")
        XCTAssertEqual(u32(wav, 16), 16)
        XCTAssertEqual(u16(wav, 20), 1, "PCM")
        XCTAssertEqual(u16(wav, 22), 1, "mono")
        XCTAssertEqual(u32(wav, 24), 16_000)
        XCTAssertEqual(u32(wav, 28), 32_000, "byte rate")
        XCTAssertEqual(u16(wav, 32), 2, "block align")
        XCTAssertEqual(u16(wav, 34), 16, "bits")
        XCTAssertEqual(String(decoding: wav[36..<40], as: UTF8.self), "data")
        XCTAssertEqual(u32(wav, 40), 6)
        XCTAssertEqual(wav.suffix(6), pcm)
    }

    func testOddTrailingByteDropped() {
        let wav = WavEncoder.encode(pcm: Data([1, 2, 3]))
        XCTAssertEqual(wav.count, 46)
        XCTAssertEqual(u32(wav, 40), 2)
    }

    func testSamplesAreLittleEndian() {
        let pcm = WavEncoder.pcm16LE([0x0102, -1, Int16.min])
        XCTAssertEqual([UInt8](pcm), [0x02, 0x01, 0xFF, 0xFF, 0x00, 0x80])
    }

    func testDuration() {
        XCTAssertEqual(WavEncoder.durationMs(pcmBytes: 32_000), 1000)
        XCTAssertEqual(WavEncoder.durationMs(pcmBytes: 9_600), 300)
    }

    func testFloatToInt16Clamps() {
        XCTAssertEqual(WavEncoder.floatToInt16([0, 1, -1, 2, -2, .nan, 0.5]), [0, 32767, -32767, 32767, -32767, 0, 16384])
    }

    func testPCMBuffer() {
        var b = PCMBuffer()
        b.append(Data([1, 2]))
        b.appendSilence(byteCount: 2)
        b.appendSilence(byteCount: -1)
        XCTAssertEqual([UInt8](b.data), [1, 2, 0, 0])
        b.reset()
        XCTAssertEqual(b.count, 0)
    }
}

/** Same cases as android/phone UtteranceAssemblerTest.kt. */
final class UtteranceAssemblerTests: XCTestCase {
    private func pkt(_ seq: Int, _ pcm: UInt8...) -> Data { Data([UInt8(seq & 0xFF)] + pcm) }

    func testInOrderPacketsConcatenateWithoutSeqByte() throws {
        var a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(7, 1, 2))
        a.onAudio(pkt(8, 3, 4))
        let u = try XCTUnwrap(a.finish())
        XCTAssertEqual([UInt8](u.pcm), [1, 2, 3, 4])
        XCTAssertEqual(u.stats.packets, 2)
        XCTAssertFalse(u.stats.degraded)
        XCTAssertNil(u.stats.warning)
        XCTAssertFalse(a.isActive)
    }

    func testSequenceWrapsAt255() throws {
        var a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(254, 1, 1))
        a.onAudio(pkt(255, 2, 2))
        a.onAudio(pkt(0, 3, 3))
        a.onAudio(pkt(1, 4, 4))
        let u = try XCTUnwrap(a.finish())
        XCTAssertEqual(u.pcm.count, 8)
        XCTAssertEqual(u.stats.gaps, 0)
    }

    func testSmallGapIsPaddedWithSilenceAndFlagged() throws {
        var a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(10, 1, 2))
        a.onAudio(pkt(13, 5, 6)) // 11 and 12 lost
        let u = try XCTUnwrap(a.finish())
        XCTAssertEqual([UInt8](u.pcm), [1, 2, 0, 0, 0, 0, 5, 6])
        XCTAssertEqual(u.stats.gaps, 1)
        XCTAssertEqual(u.stats.missingPackets, 2)
        XCTAssertTrue(u.stats.degraded)
        XCTAssertNotNil(u.stats.warning)
    }

    func testGapAcrossWrapIsPadded() throws {
        var a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(255, 1, 1))
        a.onAudio(pkt(1, 2, 2)) // 0 lost
        let u = try XCTUnwrap(a.finish())
        XCTAssertEqual([UInt8](u.pcm), [1, 1, 0, 0, 2, 2])
        XCTAssertEqual(u.stats.missingPackets, 1)
    }

    func testDuplicatesDropped() throws {
        var a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(3, 1, 1))
        a.onAudio(pkt(3, 1, 1))
        a.onAudio(pkt(4, 2, 2))
        let u = try XCTUnwrap(a.finish())
        XCTAssertEqual([UInt8](u.pcm), [1, 1, 2, 2])
        XCTAssertEqual(u.stats.duplicates, 1)
        XCTAssertFalse(u.stats.degraded)
    }

    func testLatePacketDroppedAndFlagged() throws {
        var a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(20, 1, 1))
        a.onAudio(pkt(21, 2, 2))
        a.onAudio(pkt(19, 9, 9)) // arrived late
        a.onAudio(pkt(22, 3, 3))
        let u = try XCTUnwrap(a.finish())
        XCTAssertEqual([UInt8](u.pcm), [1, 1, 2, 2, 3, 3])
        XCTAssertEqual(u.stats.outOfOrder, 1)
        XCTAssertTrue(u.stats.degraded)
    }

    func testLargeGapNotPaddedButFlagged() throws {
        var a = UtteranceAssembler(maxPaddedGap: 2)
        a.start()
        a.onAudio(pkt(0, 1, 1))
        a.onAudio(pkt(50, 2, 2))
        let u = try XCTUnwrap(a.finish())
        XCTAssertEqual([UInt8](u.pcm), [1, 1, 2, 2])
        XCTAssertEqual(u.stats.gaps, 1)
        XCTAssertEqual(u.stats.missingPackets, 49)
    }

    func testZeroPaddedGapDoesNotCrash() throws {
        var a = UtteranceAssembler(maxPaddedGap: 0)
        a.start()
        a.onAudio(pkt(0, 1, 1))
        a.onAudio(pkt(2, 2, 2))
        let u = try XCTUnwrap(a.finish())
        XCTAssertEqual([UInt8](u.pcm), [1, 1, 2, 2])
        XCTAssertEqual(u.stats.missingPackets, 1)
    }

    func testCancelDiscardsAndInactiveIgnoresAudio() {
        var a = UtteranceAssembler()
        a.onAudio(pkt(0, 1, 1)) // not started: ignored
        XCTAssertNil(a.finish())
        a.start()
        a.onAudio(pkt(0, 1, 1))
        a.cancel()
        XCTAssertNil(a.finish())
    }

    func testTooShortPacketIgnored() throws {
        var a = UtteranceAssembler()
        a.start()
        a.onAudio(Data([5]))
        let u = try XCTUnwrap(a.finish())
        XCTAssertEqual(u.pcm.count, 0)
        XCTAssertEqual(u.stats.packets, 0)
    }

    func testRestartResetsSequenceBaseline() throws {
        var a = UtteranceAssembler()
        a.start()
        a.onAudio(pkt(100, 1, 1))
        _ = a.finish()
        a.start()
        a.onAudio(pkt(5, 2, 2)) // new baseline: not a gap
        let u = try XCTUnwrap(a.finish())
        XCTAssertEqual(u.stats.gaps, 0)
        XCTAssertEqual(u.stats.outOfOrder, 0)
    }

    func testCapTruncates() throws {
        var a = UtteranceAssembler(maxBytes: 3)
        a.start()
        a.onAudio(pkt(0, 1, 2))
        a.onAudio(pkt(1, 3, 4))
        let u = try XCTUnwrap(a.finish())
        XCTAssertEqual([UInt8](u.pcm), [1, 2, 3])
        XCTAssertTrue(u.stats.truncated)
    }

    func testProtocolConstants() {
        XCTAssertEqual(MedallionProtocol.serviceUUID.lowercased(), "5a1d0001-5e1d-4b1a-9e1d-51de4b1a0001")
        XCTAssertEqual(MedallionProtocol.audioUUID.lowercased(), "5a1d0002-5e1d-4b1a-9e1d-51de4b1a0001")
        XCTAssertEqual(MedallionProtocol.controlUUID.lowercased(), "5a1d0003-5e1d-4b1a-9e1d-51de4b1a0001")
        XCTAssertEqual(MedallionProtocol.batteryUUID.lowercased(), "5a1d0004-5e1d-4b1a-9e1d-51de4b1a0001")
        XCTAssertEqual(MedallionProtocol.Control.allCases.map(\.rawValue), [0x01, 0x02, 0x03, 0x10, 0x11, 0x12])
        XCTAssertTrue(MedallionProtocol.Control.cancel.isFromMedallion)
        XCTAssertFalse(MedallionProtocol.Control.thinking.isFromMedallion)
        XCTAssertEqual(MedallionProtocol.batteryPercent(Data([87])), 87)
        XCTAssertEqual(MedallionProtocol.batteryPercent(Data([250])), 100)
        XCTAssertNil(MedallionProtocol.batteryPercent(Data()))
    }
}

final class TokenStoreTests: XCTestCase {
    func testInMemoryStore() throws {
        let s = InMemoryTokenStore()
        XCTAssertFalse(s.isPaired)
        XCTAssertNil(s.token())
        try s.save(DeviceCredentials(baseURL: "https://b.example.com", token: "t1", deviceId: "d1", device: .phone))
        XCTAssertTrue(s.isPaired)
        XCTAssertEqual(s.token(), "t1")
        try s.clear()
        XCTAssertFalse(s.isPaired)
    }

    func testEmptyTokenIsNotPaired() throws {
        let s = InMemoryTokenStore(DeviceCredentials(baseURL: "https://b.example.com", token: ""))
        XCTAssertFalse(s.isPaired)
    }

    func testCredentialsCodable() throws {
        let c = DeviceCredentials(baseURL: "https://b", token: "t", deviceId: nil, device: .phone)
        XCTAssertEqual(try JSONDecoder().decode(DeviceCredentials.self, from: JSONEncoder().encode(c)), c)
    }
}
