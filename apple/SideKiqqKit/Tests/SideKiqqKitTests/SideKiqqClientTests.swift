import XCTest
@testable import SideKiqqKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class SideKiqqClientTests: XCTestCase {
    private var client: SideKiqqClient!

    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
        client = SideKiqqClient(baseURL: URL(string: "https://brain.example.com")!,
                                tokenProvider: { "tok_123" },
                                configuration: MockURLProtocol.configuration())
    }

    override func tearDown() {
        MockURLProtocol.reset()
        client = nil
        super.tearDown()
    }

    private var last: RecordedRequest { MockURLProtocol.requests.last! }

    private func bodyObject(_ r: RecordedRequest) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: r.body) as? [String: Any])
    }

    // MARK: - Routes

    func testAsk() async throws {
        MockURLProtocol.set { _ in .json(Fixtures.askResponse) }
        let r = try await client.ask(text: "what do I owe Dana?", device: .phone, conversationId: "c_9f2a")
        XCTAssertEqual(r.spoken, "You owe Dana the revised proposal by Friday. I drafted a note.")
        XCTAssertEqual(last.method, "POST")
        XCTAssertEqual(last.url.path, "/api/ask")
        XCTAssertEqual(last.header("Authorization"), "Bearer tok_123")
        XCTAssertEqual(last.header("Content-Type"), "application/json")
        let o = try bodyObject(last)
        XCTAssertEqual(o["text"] as? String, "what do I owe Dana?")
        XCTAssertEqual(o["device"] as? String, "phone")
        XCTAssertEqual(o["conversationId"] as? String, "c_9f2a")
    }

    func testTranscribeUploadsWav() async throws {
        MockURLProtocol.set { _ in .json(Fixtures.transcribe) }
        let wav = WavEncoder.encode(samples: [0, 1, -1, 1000])
        let text = try await client.transcribe(wav: wav)
        XCTAssertEqual(text, "what's on my plate today")
        XCTAssertEqual(last.url.path, "/api/transcribe")
        XCTAssertEqual(last.header("Content-Type"), "audio/wav")
        XCTAssertEqual(last.body, wav)
    }

    func testBriefTop5FollowUpsCommitments() async throws {
        MockURLProtocol.set { req in
            switch req.url.path {
            case "/api/brief": return .json(Fixtures.brief)
            case "/api/top5": return .json(Fixtures.top5)
            case "/api/followups": return .json(Fixtures.followUps)
            case "/api/commitments": return .json(Fixtures.commitments)
            default: return .json("{}", status: 404)
            }
        }
        let brief = try await client.brief(kind: .weekly)
        XCTAssertEqual(last.url.query, "kind=weekly")
        XCTAssertEqual(brief.sections.count, 2)

        let top = try await client.top5()
        XCTAssertEqual(top.items.count, 2)
        XCTAssertEqual(last.method, "GET")

        let f = try await client.followUps()
        XCTAssertEqual(f.map(\.id), ["f1", "f2"])

        let c = try await client.commitments(status: .all)
        XCTAssertEqual(last.url.query, "status=all")
        XCTAssertEqual(c.count, 2)
        _ = try await client.commitments()
        XCTAssertEqual(last.url.query, "status=open")
    }

    func testCompleteCommitmentEncodesId() async throws {
        MockURLProtocol.set { _ in .json(Fixtures.ok) }
        try await client.completeCommitment(id: "cm/1 x")
        XCTAssertEqual(last.method, "POST")
        XCTAssertEqual(last.url.absoluteString, "https://brain.example.com/api/commitments/cm%2F1%20x/complete")
    }

    func testDraftsApproveDiscard() async throws {
        MockURLProtocol.set { req in
            req.url.path == "/api/drafts" ? .json(Fixtures.drafts) : .json(Fixtures.ok)
        }
        let drafts = try await client.pendingDrafts()
        XCTAssertEqual(drafts.map(\.id), ["dr_1", "dr_2"])
        XCTAssertEqual(last.method, "GET")

        try await client.approveDraft(id: "dr_1")
        XCTAssertEqual(last.method, "POST")
        XCTAssertEqual(last.url.path, "/api/drafts/dr_1/approve")
        XCTAssertEqual(last.header("Authorization"), "Bearer tok_123")

        try await client.discardDraft(id: "dr_2")
        XCTAssertEqual(last.url.path, "/api/drafts/dr_2/discard")
    }

    func testApproveConflictSurfacesBrainError() async {
        MockURLProtocol.set { _ in .json(Fixtures.error409, status: 409) }
        do {
            try await client.approveDraft(id: "dr_1")
            XCTFail("expected error")
        } catch let e as SideKiqqAPIError {
            XCTAssertEqual(e, .http(status: 409, code: "not_pending", message: "Draft is sent, not pending", body: Fixtures.error409))
            XCTAssertEqual(e.status, 409)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testAlertsCursorAndLimit() async throws {
        MockURLProtocol.set { _ in .json(Fixtures.alerts) }
        let page = try await client.alerts(since: "40", limit: 500)
        XCTAssertEqual(page.items.count, 2)
        let q = URLComponents(url: last.url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(q.first { $0.name == "since" }?.value, "40")
        XCTAssertEqual(q.first { $0.name == "limit" }?.value, "100", "limit is clamped to 1...100")

        _ = try await client.alerts()
        XCTAssertNil(last.url.query)
    }

    func testSpeakReturnsWavAndRate() async throws {
        let wav = WavEncoder.encode(samples: [1, 2, 3], sampleRate: 24_000)
        MockURLProtocol.set { _ in
            MockResponse(status: 200, body: wav, headers: ["Content-Type": "audio/wav", "X-Sample-Rate": "24000"])
        }
        let audio = try await client.speak(text: "Hello there", voice: .alloy)
        XCTAssertEqual(audio.wav, wav)
        XCTAssertEqual(audio.sampleRate, 24_000)
        XCTAssertEqual(last.header("Accept"), "audio/wav")
        XCTAssertEqual(try bodyObject(last)["voice"] as? String, "alloy")
    }

    func testSpeakTooLongIs413() async {
        MockURLProtocol.set { _ in .json(#"{"error":"text too long (max 1000 characters)","code":"text_too_long"}"#, status: 413) }
        do {
            _ = try await client.speak(text: String(repeating: "a", count: 2000))
            XCTFail("expected 413")
        } catch {
            XCTAssertEqual((error as? SideKiqqAPIError)?.status, 413)
        }
    }

    func testRegisterDevice() async throws {
        MockURLProtocol.set { _ in .json(Fixtures.ok) }
        try await client.registerDevice(pushToken: "apns_abc")
        XCTAssertEqual(last.url.path, "/api/devices/register")
        let o = try bodyObject(last)
        XCTAssertEqual(o["fcmToken"] as? String, "apns_abc")
        XCTAssertEqual(o["device"] as? String, "phone")
    }

    // MARK: - Pairing

    func testPairSendsNoBearerAndNormalizesCode() async throws {
        MockURLProtocol.set { _ in .json(Fixtures.pair) }
        let r = try await client.pair(code: " 123 456 ", name: "Stimmel's iPhone")
        XCTAssertEqual(r.token, "sk_dev_abc123")
        XCTAssertNil(last.header("Authorization"), "pairing is unauthenticated")
        let o = try bodyObject(last)
        XCTAssertEqual(o["code"] as? String, "123456")
        XCTAssertEqual(o["device"] as? String, "phone")
        XCTAssertEqual(o["name"] as? String, "Stimmel's iPhone")
    }

    func testPairRejectsBadCodeWithoutCallingBrain() async {
        MockURLProtocol.set { _ in .json(Fixtures.pair) }
        do {
            _ = try await client.pair(code: "12345")
            XCTFail("expected invalid input")
        } catch {
            guard case .invalidInput? = error as? SideKiqqAPIError else { return XCTFail("got \(error)") }
        }
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testPairInvalidCodeFromBrain() async {
        MockURLProtocol.set { _ in .json(Fixtures.error401, status: 401) }
        do {
            _ = try await client.pair(code: "123456")
            XCTFail("expected 401")
        } catch let e as SideKiqqAPIError {
            guard case let .http(status, code, _, _) = e else { return XCTFail("got \(e)") }
            XCTAssertEqual(status, 401)
            XCTAssertEqual(code, "invalid_code")
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testNoTokenMeansNoAuthHeader() async throws {
        let c = SideKiqqClient(baseURL: URL(string: "https://brain.example.com/")!, tokenProvider: { nil },
                               configuration: MockURLProtocol.configuration())
        MockURLProtocol.set { _ in .json(Fixtures.top5) }
        _ = try await c.top5()
        XCTAssertNil(last.header("Authorization"))
        XCTAssertEqual(last.url.absoluteString, "https://brain.example.com/api/top5", "no double slash")
    }

    func testDecodingErrorOnContractMismatch() async {
        MockURLProtocol.set { _ in .json(#"{"items":"nope"}"#) }
        do {
            _ = try await client.followUps()
            XCTFail("expected decoding error")
        } catch {
            guard case .decoding? = error as? SideKiqqAPIError else { return XCTFail("got \(error)") }
        }
    }

    // MARK: - Input normalization

    func testNormalizeBaseURL() {
        XCTAssertEqual(SideKiqqClient.normalizeBaseURL(" sidekiqq.vercel.app/ ")?.absoluteString, "https://sidekiqq.vercel.app")
        XCTAssertEqual(SideKiqqClient.normalizeBaseURL("https://brain.example.com//")?.absoluteString, "https://brain.example.com")
        XCTAssertEqual(SideKiqqClient.normalizeBaseURL("http://192.168.1.5:3000")?.absoluteString, "http://192.168.1.5:3000")
        XCTAssertNil(SideKiqqClient.normalizeBaseURL(""))
        XCTAssertNil(SideKiqqClient.normalizeBaseURL("ftp://x.com"))
        XCTAssertNil(SideKiqqClient.normalizeBaseURL("https://x.com?a=1"))
        XCTAssertNil(SideKiqqClient.normalizeBaseURL("not a url"))
        XCTAssertNil(SideKiqqClient.normalizeBaseURL("FTP://x.com"))
        XCTAssertNil(SideKiqqClient.normalizeBaseURL("https://x.com:"))
        XCTAssertNil(SideKiqqClient.normalizeBaseURL("https://user:pw@x.com"))
        XCTAssertEqual(SideKiqqClient.normalizeBaseURL("HTTPS://Brain.Example.com")?.host?.lowercased(), "brain.example.com")
    }

    func testNormalizePairingCode() {
        XCTAssertEqual(SideKiqqClient.normalizePairingCode("123-456"), "123456")
        XCTAssertNil(SideKiqqClient.normalizePairingCode("12345a"))
        XCTAssertNil(SideKiqqClient.normalizePairingCode("1234567"))
        XCTAssertNil(SideKiqqClient.normalizePairingCode("١٢٣٤٥٦"), "ASCII digits only")
    }
}
