import XCTest
@testable import SideKiqqKit

/** Records every call; `approveDraft` calls are what the safety tests watch. */
final class FakeAPI: SideKiqqAPI, @unchecked Sendable {
    private let lock = NSLock()
    var transcript = "what do I owe Dana?"
    var askResponse = try! SideKiqqJSON.decoder().decode(AskResponse.self, from: Fixtures.data(Fixtures.askResponse))
    var drafts = try! SideKiqqJSON.decoder().decode(ItemsResponse<Draft>.self, from: Fixtures.data(Fixtures.drafts)).items
    var failDrafts = false
    var failApprove = false
    private(set) var approved: [String] = []
    private(set) var asked: [(text: String, conversationId: String?)] = []

    func setTranscript(_ t: String) { lock.lock(); transcript = t; lock.unlock() }

    func transcribe(wav: Data) async throws -> String {
        lock.lock(); defer { lock.unlock() }
        XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
        return transcript
    }

    func ask(text: String, device: DeviceKind, conversationId: String?) async throws -> AskResponse {
        lock.lock(); defer { lock.unlock() }
        asked.append((text, conversationId))
        return askResponse
    }

    func pendingDrafts() async throws -> [Draft] {
        if failDrafts { throw SideKiqqAPIError.transport("offline") }
        return drafts
    }

    func approveDraft(id: String) async throws {
        if failApprove { throw SideKiqqAPIError.http(status: 410, code: "gone", message: nil, body: "") }
        lock.lock(); defer { lock.unlock() }
        approved.append(id)
    }
}

final class SpokenLog: VoiceOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var _lines: [String] = []
    var lines: [String] {
        lock.lock(); defer { lock.unlock() }
        return _lines
    }
    func speak(_ text: String) async {
        lock.lock(); _lines.append(text); lock.unlock()
    }
}

final class VoiceAssistantTests: XCTestCase {
    private let oneSecond = Data(count: 32_000)

    private func make(_ api: FakeAPI?, clock: TestClock = TestClock()) -> VoiceAssistant {
        VoiceAssistant(api: { api }, now: clock.fn)
    }

    func testAnswerThenReadbackArmsConfirmation() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let va = make(api)
        let o = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out)
        guard case let .answered(t, _, awaiting) = o else { return XCTFail("got \(o)") }
        XCTAssertEqual(t, "what do I owe Dana?")
        XCTAssertTrue(awaiting)
        XCTAssertEqual(out.lines.first, "You owe Dana the revised proposal by Friday. I drafted a note.")
        let readback = out.lines.last ?? ""
        XCTAssertTrue(readback.contains("Dana Smith"))
        XCTAssertTrue(readback.contains("Subject: Revised proposal"))
        XCTAssertTrue(readback.contains("It says: The revised proposal is attached"))
        XCTAssertTrue(readback.hasSuffix("Say 'send it' to confirm, or anything else to cancel."))
        let pending = await va.pendingDraftId
        XCTAssertEqual(pending, "dr_1")
        XCTAssertEqual(api.approved, [], "nothing sent yet")
    }

    func testSendItWithinWindowApprovesExactlyOnce() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let clock = TestClock()
        let va = make(api, clock: clock)
        _ = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out)
        clock.advance(10)
        api.setTranscript("Send it.")
        let o = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out)
        XCTAssertEqual(o, .draftSent(draftId: "dr_1"))
        XCTAssertEqual(api.approved, ["dr_1"])
        XCTAssertEqual(out.lines.last, VoiceAssistant.sent)
        XCTAssertEqual(api.asked.count, 1, "'send it' is never forwarded to /api/ask")
        // Saying it again does nothing.
        let again = await va.handleText("send it", device: .phone, output: out)
        guard case .answered = again else { return XCTFail("got \(again)") }
        XCTAssertEqual(api.approved, ["dr_1"])
    }

    func testAnythingElseDeclines() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let va = make(api)
        _ = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out)
        api.setTranscript("yes")
        let o = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out)
        XCTAssertEqual(o, .draftNotSent)
        XCTAssertEqual(out.lines.last, VoiceAssistant.notSent)
        XCTAssertEqual(api.approved, [])
    }

    func testLateSendItIsNotSentAndNotAsked() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let clock = TestClock()
        let va = make(api, clock: clock)
        _ = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out)
        clock.advance(31)
        let o = await va.handleText("send it", device: .phone, output: out)
        XCTAssertEqual(o, .draftNotSent)
        XCTAssertEqual(out.lines.last, VoiceAssistant.windowClosed)
        XCTAssertEqual(api.approved, [])
        XCTAssertEqual(api.asked.count, 1)
    }

    func testExpiredWindowTreatsOtherSpeechAsNewQuestion() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let clock = TestClock()
        let va = make(api, clock: clock)
        _ = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out)
        clock.advance(45)
        api.askResponse = try! SideKiqqJSON.decoder().decode(AskResponse.self, from: Fixtures.data(Fixtures.askResponseNoActions))
        let o = await va.handleText("what's next", device: .phone, output: out)
        guard case let .answered(_, _, awaiting) = o else { return XCTFail("got \(o)") }
        XCTAssertFalse(awaiting)
        XCTAssertEqual(api.asked.count, 2)
        XCTAssertEqual(api.approved, [])
    }

    func testSilenceWhilePendingCancels() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let va = make(api)
        _ = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out)
        api.setTranscript("   ")
        let o = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out)
        XCTAssertEqual(o, .draftNotSent)
        let pending = await va.pendingDraftId
        XCTAssertNil(pending)
        XCTAssertEqual(api.approved, [])
    }

    func testDraftThatCannotBeLoadedIsNotOfferedByVoice() async {
        let api = FakeAPI()
        api.failDrafts = true
        let out = SpokenLog()
        let va = make(api)
        let o = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out)
        guard case let .answered(_, _, awaiting) = o else { return XCTFail("got \(o)") }
        XCTAssertFalse(awaiting)
        XCTAssertEqual(out.lines.last, VoiceAssistant.reviewInApp)
        api.setTranscript("send it")
        _ = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out)
        XCTAssertEqual(api.approved, [])
    }

    func testDraftMissingFromPendingListIsNotOffered() async {
        let api = FakeAPI()
        api.drafts = []
        let va = make(api)
        let out = SpokenLog()
        let o = await va.handleText("hi", device: .phone, output: out)
        guard case let .answered(_, _, awaiting) = o else { return XCTFail("got \(o)") }
        XCTAssertFalse(awaiting)
    }

    func testApproveFailureKeepsDraft() async {
        let api = FakeAPI()
        api.failApprove = true
        let out = SpokenLog()
        let va = make(api)
        _ = await va.handleText("hi", device: .phone, output: out)
        let o = await va.handleText("send it", device: .phone, output: out)
        guard case .failed = o else { return XCTFail("got \(o)") }
        XCTAssertEqual(out.lines.last, VoiceAssistant.sendFailed)
    }

    func testShortAudioIsIgnored() async {
        let api = FakeAPI()
        let va = make(api)
        let o = await va.handleUtterance(pcm: Data(count: 100), device: .medallion, output: SpokenLog())
        XCTAssertEqual(o, .nothingHeard)
        XCTAssertTrue(api.asked.isEmpty)
    }

    func testNotPaired() async {
        let va = make(nil)
        let out = SpokenLog()
        let o = await va.handleText("hi", device: .phone, output: out)
        XCTAssertEqual(o, .notPaired)
        XCTAssertEqual(out.lines, [VoiceAssistant.notPaired])
    }

    func testConversationIdReusedWithinIdleWindow() async {
        let api = FakeAPI()
        api.askResponse = try! SideKiqqJSON.decoder().decode(AskResponse.self, from: Fixtures.data(Fixtures.askResponseNoActions))
        let clock = TestClock()
        let va = make(api, clock: clock)
        let out = SpokenLog()
        _ = await va.handleText("one", device: .phone, output: out)
        clock.advance(60)
        _ = await va.handleText("two", device: .phone, output: out)
        _ = await va.handleText("other device", device: .medallion, output: out)
        clock.advance(6 * 60)
        _ = await va.handleText("three", device: .phone, output: out)
        XCTAssertEqual(api.asked.map { $0.conversationId }, [nil, "c_1", nil, nil])
    }

    func testTypedSendItNeverConfirms() async {
        let api = FakeAPI()
        let va = make(api)
        let out = SpokenLog()
        _ = await va.handleText("hi", device: .phone, output: out)
        let o = await va.handleText("send it", device: .phone, output: out, spoken: false)
        XCTAssertEqual(o, .draftNotSent)
        XCTAssertEqual(out.lines.last, VoiceAssistant.typedSendIt)
        XCTAssertEqual(api.approved, [])
        let pending = await va.pendingDraftId
        XCTAssertNil(pending)
    }

    func testTypedQuestionCancelsPendingDraftAndIsAsked() async {
        let api = FakeAPI()
        let va = make(api)
        let out = SpokenLog()
        _ = await va.handleText("hi", device: .phone, output: out)
        api.askResponse = try! SideKiqqJSON.decoder().decode(AskResponse.self, from: Fixtures.data(Fixtures.askResponseNoActions))
        let o = await va.handleText("what's next?", device: .phone, output: out, spoken: false)
        guard case .answered = o else { return XCTFail("got \(o)") }
        XCTAssertEqual(api.asked.count, 2)
        XCTAssertEqual(api.approved, [])
    }

    func testCancelPendingDraft() async {
        let api = FakeAPI()
        let va = make(api)
        let out = SpokenLog()
        _ = await va.handleText("hi", device: .phone, output: out)
        await va.cancelPendingDraft()
        let o = await va.handleText("send it", device: .phone, output: out)
        guard case .answered = o else { return XCTFail("got \(o)") }
        XCTAssertEqual(api.approved, [])
    }
}
