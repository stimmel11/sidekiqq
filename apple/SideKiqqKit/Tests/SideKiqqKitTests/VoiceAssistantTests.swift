import XCTest
@testable import SideKiqqKit

/**
 * Records every call; `approveDraft` calls are what the safety tests watch.
 * Locked sections live in synchronous helpers (NSLock must not be used directly in async functions).
 */
final class FakeAPI: SideKiqqAPI, @unchecked Sendable {
    private let lock = NSLock()
    var transcript = "what do I owe Dana?"
    var askResponse = try! SideKiqqJSON.decoder().decode(AskResponse.self, from: Fixtures.data(Fixtures.askResponse))
    var drafts = try! SideKiqqJSON.decoder().decode(ItemsResponse<Draft>.self, from: Fixtures.data(Fixtures.drafts)).items
    var failDrafts = false
    var approveError: SideKiqqAPIError?
    private var _approved: [String] = []
    private var _asked: [(text: String, conversationId: String?)] = []

    var approved: [String] { locked { _approved } }
    var asked: [(text: String, conversationId: String?)] { locked { _asked } }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }

    func setTranscript(_ t: String) { locked { transcript = t } }

    func transcribe(wav: Data) async throws -> String {
        XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
        return locked { transcript }
    }

    func ask(text: String, device: DeviceKind, conversationId: String?) async throws -> AskResponse {
        locked {
            _asked.append((text, conversationId))
            return askResponse
        }
    }

    func pendingDrafts() async throws -> [Draft] {
        if failDrafts { throw SideKiqqAPIError.transport("offline") }
        return drafts
    }

    func approveDraft(id: String) async throws {
        if let approveError { throw approveError }
        locked { _approved.append(id) }
    }
}

/** Records what was spoken. `interruptReadbacks` simulates a barge-in during the draft read-back. */
final class SpokenLog: VoiceOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var _lines: [String] = []
    var interruptReadbacks = false

    var lines: [String] { locked { _lines } }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }

    private func record(_ text: String) -> Bool {
        locked {
            _lines.append(text)
            return !(interruptReadbacks && text.hasSuffix(DraftConfirmation.confirmInstruction))
        }
    }

    func speak(_ text: String) async -> Bool { record(text) }
}

final class VoiceAssistantTests: XCTestCase {
    private let oneSecond = Data(count: 32_000)
    /** Default clock for tests that don't move time; `startedAt: clock.now` = "spoken after the read-back". */
    private var clock = TestClock()

    override func setUp() {
        super.setUp()
        clock = TestClock()
    }

    private func make(_ api: FakeAPI?, clock: TestClock? = nil) -> VoiceAssistant {
        let c = clock ?? self.clock
        return VoiceAssistant(api: { api }, now: c.fn)
    }

    func testAnswerThenReadbackArmsConfirmation() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let va = make(api)
        let o = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out, startedAt: clock.now)
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
        _ = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out, startedAt: clock.now)
        clock.advance(10)
        api.setTranscript("Send it.")
        let o = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out, startedAt: clock.now)
        XCTAssertEqual(o, .draftSent(draftId: "dr_1"))
        XCTAssertEqual(api.approved, ["dr_1"])
        XCTAssertEqual(out.lines.last, VoiceAssistant.sent)
        XCTAssertEqual(api.asked.count, 1, "'send it' is never forwarded to /api/ask")
        // Saying it again does nothing.
        let again = await va.handleText("send it", device: .phone, output: out, spokenAt: clock.now)
        guard case .answered = again else { return XCTFail("got \(again)") }
        XCTAssertEqual(api.approved, ["dr_1"])
    }

    func testAnythingElseDeclines() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let va = make(api)
        _ = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out, startedAt: clock.now)
        api.setTranscript("yes")
        let o = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out, startedAt: clock.now)
        XCTAssertEqual(o, .draftNotSent)
        XCTAssertEqual(out.lines.last, VoiceAssistant.notSent)
        XCTAssertEqual(api.approved, [])
    }

    func testLateSendItIsNotSentAndNotAsked() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let clock = TestClock()
        let va = make(api, clock: clock)
        _ = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out, startedAt: clock.now)
        clock.advance(31)
        let o = await va.handleText("send it", device: .phone, output: out, spokenAt: clock.now)
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
        _ = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out, startedAt: clock.now)
        clock.advance(45)
        api.askResponse = try! SideKiqqJSON.decoder().decode(AskResponse.self, from: Fixtures.data(Fixtures.askResponseNoActions))
        let o = await va.handleText("what's next", device: .phone, output: out, spokenAt: clock.now)
        guard case let .answered(_, _, awaiting) = o else { return XCTFail("got \(o)") }
        XCTAssertFalse(awaiting)
        XCTAssertEqual(api.asked.count, 2)
        XCTAssertEqual(api.approved, [])
    }

    func testSilenceWhilePendingCancels() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let va = make(api)
        _ = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out, startedAt: clock.now)
        api.setTranscript("   ")
        let o = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out, startedAt: clock.now)
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
        let o = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out, startedAt: clock.now)
        guard case let .answered(_, _, awaiting) = o else { return XCTFail("got \(o)") }
        XCTAssertFalse(awaiting)
        XCTAssertEqual(out.lines.last, VoiceAssistant.reviewInApp)
        api.setTranscript("send it")
        _ = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out, startedAt: clock.now)
        XCTAssertEqual(api.approved, [])
    }

    func testDraftMissingFromPendingListIsNotOffered() async {
        let api = FakeAPI()
        api.drafts = []
        let va = make(api)
        let out = SpokenLog()
        let o = await va.handleText("hi", device: .phone, output: out, spokenAt: clock.now)
        guard case let .answered(_, _, awaiting) = o else { return XCTFail("got \(o)") }
        XCTAssertFalse(awaiting)
    }

    func testApproveFailureKeepsDraft() async {
        let api = FakeAPI()
        api.approveError = .http(status: 410, code: "gone", message: nil, body: "")
        let out = SpokenLog()
        let va = make(api)
        _ = await va.handleText("hi", device: .phone, output: out, spokenAt: clock.now)
        let o = await va.handleText("send it", device: .phone, output: out, spokenAt: clock.now)
        guard case .failed = o else { return XCTFail("got \(o)") }
        XCTAssertEqual(out.lines.last, VoiceAssistant.sendFailed)
    }

    func testShortAudioIsIgnored() async {
        let api = FakeAPI()
        let va = make(api)
        let o = await va.handleUtterance(pcm: Data(count: 100), device: .medallion, output: SpokenLog(), startedAt: clock.now)
        XCTAssertEqual(o, .nothingHeard)
        XCTAssertTrue(api.asked.isEmpty)
    }

    func testNotPaired() async {
        let va = make(nil)
        let out = SpokenLog()
        let o = await va.handleText("hi", device: .phone, output: out, spokenAt: clock.now)
        XCTAssertEqual(o, .notPaired)
        XCTAssertEqual(out.lines, [VoiceAssistant.notPaired])
    }

    func testConversationIdReusedWithinIdleWindow() async {
        let api = FakeAPI()
        api.askResponse = try! SideKiqqJSON.decoder().decode(AskResponse.self, from: Fixtures.data(Fixtures.askResponseNoActions))
        let clock = TestClock()
        let va = make(api, clock: clock)
        let out = SpokenLog()
        _ = await va.handleText("one", device: .phone, output: out, spokenAt: clock.now)
        clock.advance(60)
        _ = await va.handleText("two", device: .phone, output: out, spokenAt: clock.now)
        _ = await va.handleText("other device", device: .medallion, output: out, spokenAt: clock.now)
        clock.advance(6 * 60)
        _ = await va.handleText("three", device: .phone, output: out, spokenAt: clock.now)
        XCTAssertEqual(api.asked.map { $0.conversationId }, [nil, "c_1", nil, nil])
    }

    func testTypedSendItNeverConfirms() async {
        let api = FakeAPI()
        let va = make(api)
        let out = SpokenLog()
        _ = await va.handleText("hi", device: .phone, output: out, spokenAt: clock.now)
        let o = await va.handleText("send it", device: .phone, output: out, spokenAt: nil)
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
        _ = await va.handleText("hi", device: .phone, output: out, spokenAt: clock.now)
        api.askResponse = try! SideKiqqJSON.decoder().decode(AskResponse.self, from: Fixtures.data(Fixtures.askResponseNoActions))
        let o = await va.handleText("what's next?", device: .phone, output: out, spokenAt: nil)
        guard case .answered = o else { return XCTFail("got \(o)") }
        XCTAssertEqual(api.asked.count, 2)
        XCTAssertEqual(api.approved, [])
    }

    func testInterruptedReadbackNeverArmsTheWindow() async {
        let api = FakeAPI()
        let out = SpokenLog()
        out.interruptReadbacks = true
        let va = make(api)
        let o = await va.handleUtterance(pcm: oneSecond, device: .medallion, output: out, startedAt: clock.now)
        guard case let .answered(_, _, awaiting) = o else { return XCTFail("got \(o)") }
        XCTAssertFalse(awaiting)
        XCTAssertEqual(out.lines.last, VoiceAssistant.reviewInApp)
        api.setTranscript("send it")
        _ = await va.handleUtterance(pcm: oneSecond, device: .medallion, output: out, startedAt: clock.now)
        XCTAssertEqual(api.approved, [], "a read-back the owner didn't fully hear can't be confirmed")
    }

    func testSendItSpokenOverTheReadbackDeclines() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let clock = TestClock()
        let va = make(api, clock: clock)
        let startedDuringReadback = clock.now
        clock.advance(0.5)
        _ = await va.handleUtterance(pcm: oneSecond, device: .medallion, output: out, startedAt: clock.now)
        clock.advance(2)
        api.setTranscript("send it")
        let o = await va.handleUtterance(pcm: oneSecond, device: .medallion, output: out, startedAt: startedDuringReadback)
        XCTAssertEqual(o, .draftNotSent)
        XCTAssertEqual(api.approved, [])
    }

    func testSendItStartedAfterWindowOpenedConfirms() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let clock = TestClock()
        let va = make(api, clock: clock)
        _ = await va.handleUtterance(pcm: oneSecond, device: .medallion, output: out, startedAt: clock.now)
        clock.advance(3)
        api.setTranscript("send it")
        let o = await va.handleUtterance(pcm: oneSecond, device: .medallion, output: out, startedAt: clock.now)
        XCTAssertEqual(o, .draftSent(draftId: "dr_1"))
        XCTAssertEqual(api.approved, ["dr_1"])
    }

    func testDraftEditedAfterReadbackIsNotSent() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let va = make(api)
        _ = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out, startedAt: clock.now)
        api.drafts[0].to = ["someone-else@example.com"] // changed on the brain after the read-back
        api.setTranscript("send it")
        let o = await va.handleUtterance(pcm: oneSecond, device: .phone, output: out, startedAt: clock.now)
        XCTAssertEqual(o, .draftNotSent)
        XCTAssertEqual(out.lines.last, VoiceAssistant.draftChanged)
        XCTAssertEqual(api.approved, [])
    }

    func testDraftGoneAfterReadbackIsNotSent() async {
        let api = FakeAPI()
        let out = SpokenLog()
        let va = make(api)
        _ = await va.handleText("hi", device: .phone, output: out, spokenAt: clock.now)
        api.drafts = []
        let o = await va.handleText("send it", device: .phone, output: out, spokenAt: clock.now)
        XCTAssertEqual(o, .draftNotSent)
        XCTAssertEqual(api.approved, [])
    }

    func testApproveTimeoutIsReportedAsUncertain() async {
        let api = FakeAPI()
        api.approveError = .transport("timed out")
        let out = SpokenLog()
        let va = make(api)
        _ = await va.handleText("hi", device: .phone, output: out, spokenAt: clock.now)
        let o = await va.handleText("send it", device: .phone, output: out, spokenAt: clock.now)
        guard case .failed = o else { return XCTFail("got \(o)") }
        XCTAssertEqual(out.lines.last, VoiceAssistant.sendUncertain)
    }

    func testCancelPendingDraft() async {
        let api = FakeAPI()
        let va = make(api)
        let out = SpokenLog()
        _ = await va.handleText("hi", device: .phone, output: out, spokenAt: clock.now)
        await va.cancelPendingDraft()
        let o = await va.handleText("send it", device: .phone, output: out, spokenAt: clock.now)
        guard case .answered = o else { return XCTFail("got \(o)") }
        XCTAssertEqual(api.approved, [])
    }
}
