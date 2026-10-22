import XCTest
@testable import SideKiqqKit

/** A settable clock for the 30 s window. */
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var t = Date(timeIntervalSince1970: 1_000_000)
    var now: Date {
        lock.lock(); defer { lock.unlock() }
        return t
    }
    func advance(_ s: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        t = t.addingTimeInterval(s)
    }
    var fn: @Sendable () -> Date { { [self] in self.now } }
}

/** Same cases as android/phone DraftConfirmationTest.kt, plus the read-back. */
final class DraftConfirmationTests: XCTestCase {
    func testOnlyExactSendItConfirms() {
        for s in ["send it", "Send it.", "  SEND   IT! ", "Send it!"] {
            XCTAssertTrue(DraftConfirmation.isSendIt(s), s)
        }
        for s in ["don't send it", "do not send it", "send it later", "yes", "sure", "send", "send it to someone else",
                  "okay send it", "", "sent it", "don’t send it", "send it send it"] {
            XCTAssertFalse(DraftConfirmation.isSendIt(s), s)
        }
    }

    func testNormalize() {
        XCTAssertEqual(DraftConfirmation.normalize("  Don't, SEND—it!! "), "don't send it")
        XCTAssertEqual(DraftConfirmation.normalize("\tsend\nit"), "send it")
    }

    func testConfirmsWithinWindow() {
        let clock = TestClock()
        var c = DraftConfirmation(window: 30, now: clock.fn)
        let prompt = c.offer(draftId: "d1", summary: "Reply to Dana: proposal attached")
        XCTAssertEqual(prompt, "Send this: Reply to Dana: proposal attached? Say 'send it' to confirm, or anything else to cancel.")
        XCTAssertTrue(c.isAwaiting)
        clock.advance(5)
        XCTAssertEqual(c.evaluate("send it"), .confirmed(draftId: "d1"))
        XCTAssertNil(c.pending)
    }

    func testExactlyAtWindowStillConfirms() {
        let clock = TestClock()
        var c = DraftConfirmation(now: clock.fn)
        c.arm(draftId: "d1", summary: "x")
        clock.advance(30)
        XCTAssertEqual(c.evaluate("send it"), .confirmed(draftId: "d1"))
    }

    func testAnythingElseDeclinesAndConsumes() {
        var c = DraftConfirmation()
        c.offer(draftId: "d1", summary: "x")
        XCTAssertEqual(c.evaluate("what's on my calendar"), .declined)
        // A later "send it" must not resurrect the declined draft.
        XCTAssertEqual(c.evaluate("send it"), .nothingPending)
    }

    func testExpiresAfterWindow() {
        let clock = TestClock()
        var c = DraftConfirmation(window: 30, now: clock.fn)
        c.offer(draftId: "d1", summary: "x")
        clock.advance(31)
        XCTAssertFalse(c.isAwaiting)
        XCTAssertEqual(c.evaluate("send it"), .expired)
        XCTAssertEqual(c.evaluate("send it"), .nothingPending)
    }

    func testNothingPendingAndClear() {
        var c = DraftConfirmation()
        XCTAssertEqual(c.evaluate("send it"), .nothingPending)
        c.offer(draftId: "d1", summary: "x")
        c.clear()
        XCTAssertEqual(c.evaluate("send it"), .nothingPending)
    }

    func testNewOfferReplacesOld() {
        var c = DraftConfirmation()
        c.offer(draftId: "d1", summary: "x")
        c.offer(draftId: "d2", summary: "y")
        XCTAssertEqual(c.evaluate("send it"), .confirmed(draftId: "d2"))
    }

    // MARK: - Read-back

    private let dana = Draft(id: "dr_1", to: ["Dana Smith <dana@acme.com>"], subject: "Revised proposal",
                             body: "Hi Dana,\n\nThe revised proposal is attached with the updated pricing. Let me know if Friday still works.\n\nChris",
                             client: "Acme", createdAt: "2026-10-22T13:05:00.000Z")

    func testReadbackHasRecipientSubjectAndOneSentence() {
        XCTAssertEqual(DraftConfirmation.readback(for: dana),
                       "Email to Dana Smith. Subject: Revised proposal. It says: The revised proposal is attached with the updated pricing.")
        XCTAssertEqual(DraftConfirmation.prompt(for: dana),
                       "Email to Dana Smith. Subject: Revised proposal. It says: The revised proposal is attached with the updated pricing. Say 'send it' to confirm, or anything else to cancel.")
    }

    func testOfferDraftArmsWithItsId() {
        var c = DraftConfirmation()
        let p = c.offer(dana)
        XCTAssertTrue(p.hasSuffix(DraftConfirmation.confirmInstruction))
        XCTAssertEqual(c.pending?.draftId, "dr_1")
    }

    func testReadbackWithSeveralRecipientsCcAndEmptyParts() {
        let d = Draft(id: "x", to: ["mike@example.com", "\"Sam Lee\" <sam@example.com>", "ann@example.com"],
                      cc: ["ops@example.com"], subject: "  ", body: "\n\n", createdAt: "2026-10-22T00:00:00Z")
        XCTAssertEqual(DraftConfirmation.readback(for: d),
                       "Email to mike@example.com, Sam Lee and ann@example.com, copying ops@example.com. Subject: no subject. The message is empty.")
    }

    func testSpokenRecipients() {
        XCTAssertEqual(DraftConfirmation.spokenRecipients(["<a@b.com>"]), "a@b.com")
        XCTAssertEqual(DraftConfirmation.spokenRecipients([]), "no recipient")
        XCTAssertEqual(DraftConfirmation.spokenRecipients(["A <a@x>", "B <b@x>"]), "A and B")
    }

    func testBodySummary() {
        XCTAssertEqual(DraftConfirmation.bodySummary("Quick reminder on the deposit."), "Quick reminder on the deposit.")
        XCTAssertEqual(DraftConfirmation.bodySummary("Hello Mike, thanks for the call today! More below."),
                       "Hello Mike, thanks for the call today!")
        XCTAssertEqual(DraftConfirmation.bodySummary("Dear Ms. Jones,\nWe owe you v2.1 by Friday. Thanks"),
                       "We owe you v2.1 by Friday.", "decimal point is not a sentence end")
        XCTAssertEqual(DraftConfirmation.bodySummary("No punctuation here"), "No punctuation here")
        let long = String(repeating: "word ", count: 60)
        let s = DraftConfirmation.bodySummary(long, maxChars: 40)
        XCTAssertTrue(s.hasSuffix("…"))
        XCTAssertLessThanOrEqual(s.count, 41)
    }
}
