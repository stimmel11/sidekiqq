import XCTest
@testable import SideKiqqKit

final class ModelsTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try SideKiqqJSON.decoder().decode(type, from: Fixtures.data(json))
    }

    private func object(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /** decode -> encode -> decode must be lossless. */
    private func assertRoundTrip<T: Codable & Equatable>(_ type: T.Type, _ json: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let a = try decode(type, json)
        let b = try SideKiqqJSON.decoder().decode(type, from: SideKiqqJSON.encoder().encode(a))
        XCTAssertEqual(a, b, file: file, line: line)
    }

    func testAskResponse() throws {
        let r = try decode(AskResponse.self, Fixtures.askResponse)
        XCTAssertEqual(r.conversationId, "c_9f2a")
        XCTAssertEqual(r.actions.count, 2)
        XCTAssertEqual(r.actions[0].type, .draftCreated)
        XCTAssertEqual(r.actions[1].type, .commitmentAdded)
        XCTAssertEqual(r.draftActions.map(\.id), ["dr_1"])
        try assertRoundTrip(AskResponse.self, Fixtures.askResponse)
    }

    func testUnknownActionTypeAndExtraKeysAreTolerated() throws {
        let r = try decode(AskResponse.self, Fixtures.askResponseFutureAction)
        XCTAssertEqual(r.actions.first?.type.rawValue, "video_started")
        XCTAssertTrue(r.draftActions.isEmpty)
    }

    func testMissingActionsDefaultsToEmpty() throws {
        let r = try decode(AskResponse.self, #"{"reply":"a","spoken":"b","conversationId":"c"}"#)
        XCTAssertEqual(r.actions, [])
    }

    func testTop5() throws {
        let r = try decode(Top5Response.self, Fixtures.top5)
        XCTAssertEqual(r.items.count, 2)
        XCTAssertEqual(r.items[0].importance, .critical)
        XCTAssertEqual(r.items[0].dueAt, "2026-10-24T17:00:00.000Z")
        XCTAssertNil(r.items[1].dueAt)
        try assertRoundTrip(Top5Response.self, Fixtures.top5)
    }

    func testBrief() throws {
        let b = try decode(Brief.self, Fixtures.brief)
        XCTAssertEqual(b.kind, .daily)
        XCTAssertEqual(b.sections.map(\.title), ["TODAY", "MONEY"])
        XCTAssertEqual(b.sections[1].items, [])
        XCTAssertEqual(b.top5.first?.id, "t1")
        try assertRoundTrip(Brief.self, Fixtures.brief)
    }

    func testFollowUps() throws {
        let r = try decode(ItemsResponse<FollowUp>.self, Fixtures.followUps)
        XCTAssertEqual(r.items[0].daysQuiet, 9)
        XCTAssertEqual(r.items[0].draftId, "dr_1")
        XCTAssertNil(r.items[1].client)
        XCTAssertNil(r.items[1].draftId)
        XCTAssertEqual(r.items[1].importance, .medium)
    }

    func testCommitmentsAndInferredFlag() throws {
        let r = try decode(ItemsResponse<Commitment>.self, Fixtures.commitments)
        let c1 = r.items[0], c2 = r.items[1]
        XCTAssertEqual(c1.source, CommitmentSource(kind: .email, ref: "msg_123"))
        XCTAssertFalse(c1.isInferred)
        XCTAssertEqual(c2.status, .overdue)
        XCTAssertEqual(c2.source.kind, .meeting)
        XCTAssertNil(c2.source.ref)
        XCTAssertTrue(c2.isInferred)
        XCTAssertNotNil(c1.dueDate)
        for c in r.items {
            let back = try SideKiqqJSON.decoder().decode(Commitment.self, from: SideKiqqJSON.encoder().encode(c))
            XCTAssertEqual(back, c)
        }
    }

    func testConfidenceInferredAloneMarksInferred() {
        let c = Commitment(id: "x", who: "a", what: "b", madeAt: "2026-10-01T00:00:00Z", dueInferred: false,
                           status: .open, source: CommitmentSource(kind: .voice), confidence: .inferred)
        XCTAssertTrue(c.isInferred)
    }

    func testDrafts() throws {
        let r = try decode(ItemsResponse<Draft>.self, Fixtures.drafts)
        XCTAssertEqual(r.items[0].to, ["Dana Smith <dana@acme.com>"])
        XCTAssertEqual(r.items[1].cc, ["ops@example.com"])
        XCTAssertNil(r.items[1].client)
        // cc defaults to [] when absent
        let d = try decode(Draft.self, #"{"id":"d","to":["a@b.c"],"subject":"s","body":"b","createdAt":"2026-10-22T00:00:00Z"}"#)
        XCTAssertEqual(d.cc, [])
        // Older brain: no kind/readback/when.
        XCTAssertEqual(d.kind, "email")
        XCTAssertEqual(d.readback, "")
        XCTAssertNil(d.when)
        let hold = try decode(Draft.self, #"{"id":"h","kind":"calendar_hold","to":[],"subject":"Focus","body":"","readback":"Calendar hold, 'Focus', Tue Oct 27 9–10 am","when":{"start":"2026-10-27T15:00:00Z","end":"2026-10-27T16:00:00Z"},"createdAt":"2026-10-22T00:00:00Z"}"#)
        XCTAssertEqual(hold.kind, "calendar_hold")
        XCTAssertEqual(hold.when?.start, "2026-10-27T15:00:00Z")
        XCTAssertEqual(hold.readback, "Calendar hold, 'Focus', Tue Oct 27 9–10 am")
    }

    func testAlerts() throws {
        let r = try decode(AlertsResponse.self, Fixtures.alerts)
        XCTAssertEqual(r.cursor, "42")
        XCTAssertFalse(r.more)
        XCTAssertEqual(r.items[0].kind, .email)
        XCTAssertTrue(r.items[0].needsAttention)
        XCTAssertEqual(r.items[1].kind, .commitmentOverdue)
        XCTAssertNil(r.items[1].importance)
        XCTAssertFalse(r.items[1].needsAttention)
        try assertRoundTrip(AlertsResponse.self, Fixtures.alerts)
    }

    func testPairResponse() throws {
        let p = try decode(PairResponse.self, Fixtures.pair)
        XCTAssertEqual(p, PairResponse(token: "sk_dev_abc123", deviceId: "dev_77", device: .phone))
    }

    func testAskRequestOmitsNilConversationId() throws {
        let o = try object(SideKiqqJSON.encoder().encode(AskRequest(text: "hi", device: .medallion)))
        XCTAssertEqual(o["text"] as? String, "hi")
        XCTAssertEqual(o["device"] as? String, "medallion")
        XCTAssertNil(o["conversationId"])
        let o2 = try object(SideKiqqJSON.encoder().encode(AskRequest(text: "hi", device: .phone, conversationId: "c1")))
        XCTAssertEqual(o2["conversationId"] as? String, "c1")
    }

    func testRequestShapes() throws {
        let reg = try object(SideKiqqJSON.encoder().encode(RegisterDeviceRequest(fcmToken: "tok", device: "phone")))
        XCTAssertEqual(reg as? [String: String], ["fcmToken": "tok", "device": "phone"])
        let pair = try object(SideKiqqJSON.encoder().encode(PairRequest(code: "123456", device: .phone)))
        XCTAssertEqual(pair as? [String: String], ["code": "123456", "device": "phone"])
        let speak = try object(SideKiqqJSON.encoder().encode(SpeakRequest(text: "hello", voice: .nova)))
        XCTAssertEqual(speak as? [String: String], ["text": "hello", "voice": "nova"])
    }

    func testDeviceKindWireValues() throws {
        let kinds: [DeviceKind] = [.watch, .glasses, .medallion, .phone, .reachy]
        XCTAssertEqual(kinds.map(\.rawValue), ["watch", "glasses", "medallion", "phone", "reachy"])
        XCTAssertEqual(DeviceKind.thisIPhone, .phone, "today's brain has no iphone kind")
        let data = try SideKiqqJSON.encoder().encode([DeviceKind.reachy])
        XCTAssertEqual(String(decoding: data, as: UTF8.self), #"["reachy"]"#)
    }

    func testImportanceOrderingAndLabels() {
        XCTAssertTrue(Importance.critical > .high)
        XCTAssertTrue(Importance.fyi < .low)
        XCTAssertEqual(Importance.allCases.map(\.rawValue), ["CRITICAL", "HIGH", "MEDIUM", "LOW", "FYI"])
        XCTAssertEqual(Importance.fyi.label, "FYI")
    }

    func testUnknownImportanceFails() {
        XCTAssertThrowsError(try decode(TopItem.self, #"{"id":"1","title":"t","why":"w","importance":"URGENT"}"#))
    }

    func testDateParsing() {
        XCTAssertNotNil(SideKiqqDate.parse("2026-10-22T13:00:00.000Z"))
        XCTAssertNotNil(SideKiqqDate.parse("2026-10-22T13:00:00Z"))
        XCTAssertNotNil(SideKiqqDate.parse("2026-10-22"))
        XCTAssertNil(SideKiqqDate.parse("next friday"))
        let a = SideKiqqDate.parse("2026-10-22T13:00:00.500Z")!
        let b = SideKiqqDate.parse("2026-10-22T13:00:00Z")!
        XCTAssertEqual(a.timeIntervalSince(b), 0.5, accuracy: 0.001)
    }
}
