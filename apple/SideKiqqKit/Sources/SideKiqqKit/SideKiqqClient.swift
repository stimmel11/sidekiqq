import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/** Any failure talking to the brain. */
public enum SideKiqqAPIError: Error, Equatable, Sendable, CustomStringConvertible {
    /** Non-2xx response. `code`/`message` come from the brain's `{ "error", "code" }` body when present. */
    case http(status: Int, code: String?, message: String?, body: String)
    /** 2xx response whose body didn't match the contract. */
    case decoding(String)
    /** Transport failure (offline, TLS, timeout...). */
    case transport(String)
    /** Client-side validation (bad base URL, bad pairing code...). */
    case invalidInput(String)

    public var status: Int? {
        if case let .http(status, _, _, _) = self { return status }
        return nil
    }

    public var description: String {
        switch self {
        case let .http(status, code, message, body):
            return "SideKiqq API error \(status)\(code.map { " (\($0))" } ?? ""): \(message ?? String(body.prefix(300)))"
        case let .decoding(m): return "Unexpected response from SideKiqq: \(m)"
        case let .transport(m): return "Can't reach SideKiqq: \(m)"
        case let .invalidInput(m): return m
        }
    }
}

/**
 * The calls the voice loop needs. `SideKiqqClient` conforms; tests use a fake.
 */
public protocol SideKiqqAPI: Sendable {
    func transcribe(wav: Data) async throws -> String
    func ask(text: String, device: DeviceKind, conversationId: String?) async throws -> AskResponse
    func pendingDrafts() async throws -> [Draft]
    /**
     * Sends a drafted message. The ONLY call that sends anything on the owner's behalf.
     * Callers MUST have an explicit confirmation immediately before (confirm sheet, or "send it").
     */
    func approveDraft(id: String) async throws
}

/** Audio returned by `POST /api/speak`: a complete WAV file (PCM16 LE mono, 24 kHz with OpenAI). */
public struct SpokenAudio: Sendable, Equatable {
    public var wav: Data
    public var sampleRate: Int?
}

/**
 * Thin async/await client for the SideKiqq brain. Mirrors android/shared SideKiqqClient.kt and
 * covers every route in ARCHITECTURE.md plus the brain's drafts extension routes.
 *
 * Uses completion-handler `dataTask` wrapped in continuations so it also runs on Linux
 * (swift-corelibs-foundation), where the tests run in CI.
 */
public final class SideKiqqClient: SideKiqqAPI, @unchecked Sendable {
    public let baseURL: URL
    private let tokenProvider: @Sendable () -> String?
    private let session: URLSession

    /// Timeouts mirror the Android client: /api/ask runs Claude with tool calls, so give it room.
    public static let requestTimeout: TimeInterval = 90

    /**
     * - Parameters:
     *   - baseURL: e.g. `https://sidekiqq.vercel.app` (normalize user input with `normalizeBaseURL`).
     *   - tokenProvider: returns the device bearer token, or nil before pairing.
     *   - configuration: override for tests (set `protocolClasses` to a mock URLProtocol).
     */
    public init(baseURL: URL, tokenProvider: @escaping @Sendable () -> String?,
                configuration: URLSessionConfiguration = .ephemeral) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        configuration.timeoutIntervalForRequest = Self.requestTimeout
        configuration.timeoutIntervalForResource = Self.requestTimeout + 30
        configuration.httpAdditionalHeaders = (configuration.httpAdditionalHeaders ?? [:])
            .merging(["Accept": "application/json"]) { a, _ in a }
        self.session = URLSession(configuration: configuration)
    }

    deinit { session.finishTasksAndInvalidate() }

    /**
     * Normalizes what the owner typed on the pairing screen: trims, adds `https://` when no scheme
     * was typed, drops trailing slashes. Returns nil if it isn't an http(s) URL with a host.
     * Plain `http` is only accepted for localhost / LAN testing; App Transport Security blocks it elsewhere.
     */
    public static func normalizeBaseURL(_ input: String) -> URL? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        guard !s.isEmpty, !s.contains(" ") else { return nil }
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "https://" + s }
        guard let comps = URLComponents(string: s), let scheme = comps.scheme?.lowercased(),
              scheme == "https" || scheme == "http", let host = comps.host, !host.isEmpty,
              comps.query == nil, comps.fragment == nil else { return nil }
        return comps.url
    }

    /** Six digits, ignoring spaces and dashes the owner may type ("123 456"). Nil if invalid. */
    public static func normalizePairingCode(_ input: String) -> String? {
        let digits = input.filter { !$0.isWhitespace && $0 != "-" }
        guard digits.count == 6, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return digits
    }

    // MARK: - Pairing (no device token)

    /** `POST /api/devices/pair`. Exchanges a one-time code for a long-lived device token. */
    public func pair(code: String, device: DeviceKind = .thisIPhone, name: String? = nil) async throws -> PairResponse {
        guard let code = Self.normalizePairingCode(code) else {
            throw SideKiqqAPIError.invalidInput("The pairing code is the 6 digits shown on the dashboard.")
        }
        return try await send(.post, "/api/devices/pair", json: PairRequest(code: code, device: device, name: name),
                              authenticated: false)
    }

    // MARK: - Assistant

    public func ask(text: String, device: DeviceKind, conversationId: String? = nil) async throws -> AskResponse {
        try await send(.post, "/api/ask", json: AskRequest(text: text, device: device, conversationId: conversationId))
    }

    /** `wav` must be a complete RIFF/WAV file, 16 kHz mono PCM16 (see `WavEncoder`). */
    public func transcribe(wav: Data) async throws -> String {
        let r: TranscribeResponse = try await send(.post, "/api/transcribe", body: wav, contentType: "audio/wav")
        return r.text
    }

    /** `POST /api/speak`. Throws `.http(status: 413, ...)` when the text is longer than the brain allows. */
    public func speak(text: String, voice: SpeakVoice? = nil) async throws -> SpokenAudio {
        let req = try makeRequest(.post, "/api/speak", query: [], authenticated: true,
                                  body: try SideKiqqJSON.encoder().encode(SpeakRequest(text: text, voice: voice)),
                                  contentType: "application/json", accept: "audio/wav")
        let (data, http) = try await perform(req)
        try ensureOK(data, http)
        let rate = Self.header("X-Sample-Rate", in: http).flatMap { Int($0) }
        return SpokenAudio(wav: data, sampleRate: rate)
    }

    // MARK: - Briefings and lists

    public func brief(kind: BriefKind = .daily) async throws -> Brief {
        try await send(.get, "/api/brief", query: [URLQueryItem(name: "kind", value: kind.rawValue)])
    }

    public func top5() async throws -> Top5Response {
        try await send(.get, "/api/top5")
    }

    public func followUps() async throws -> [FollowUp] {
        let r: ItemsResponse<FollowUp> = try await send(.get, "/api/followups")
        return r.items
    }

    public func commitments(status: CommitmentFilter = .open) async throws -> [Commitment] {
        let r: ItemsResponse<Commitment> = try await send(.get, "/api/commitments",
                                                          query: [URLQueryItem(name: "status", value: status.rawValue)])
        return r.items
    }

    public func completeCommitment(id: String) async throws {
        try await sendOK(.post, "/api/commitments/\(Self.pathSegment(id))/complete")
    }

    /** `GET /api/alerts`. Pass the previous `cursor` as `since`; when `more` is true, call again. */
    public func alerts(since: String? = nil, limit: Int? = nil) async throws -> AlertsResponse {
        var q: [URLQueryItem] = []
        if let since, !since.isEmpty { q.append(URLQueryItem(name: "since", value: since)) }
        if let limit { q.append(URLQueryItem(name: "limit", value: String(min(max(limit, 1), 100)))) }
        return try await send(.get, "/api/alerts", query: q)
    }

    // MARK: - Drafts

    /** `GET /api/drafts` (brain extension): drafts awaiting approval, with recipients, subject and body. */
    public func pendingDrafts() async throws -> [Draft] {
        let r: ItemsResponse<Draft> = try await send(.get, "/api/drafts")
        return r.items
    }

    /**
     * Sends a drafted message. This is the ONLY call that causes anything to be sent on the owner's
     * behalf. Callers MUST obtain an explicit confirmation immediately before invoking it
     * (the confirm sheet, or `DraftConfirmation` returning `.confirmed`).
     */
    public func approveDraft(id: String) async throws {
        try await sendOK(.post, "/api/drafts/\(Self.pathSegment(id))/approve")
    }

    /** Marks a draft discarded on the brain. Never sends. */
    public func discardDraft(id: String) async throws {
        try await sendOK(.post, "/api/drafts/\(Self.pathSegment(id))/discard")
    }

    // MARK: - Devices

    /**
     * `POST /api/devices/register`. The contract names the field `fcmToken`; until the brain supports
     * APNs this is unused on iPhone (see `PushRegistrar` in the app and docs/APPLE.md).
     */
    public func registerDevice(pushToken: String, device: DeviceKind = .thisIPhone) async throws {
        try await sendOK(.post, "/api/devices/register",
                         json: RegisterDeviceRequest(fcmToken: pushToken, device: device.rawValue))
    }

    // MARK: - Plumbing

    /** Case-insensitive header lookup that behaves the same on Darwin and swift-corelibs-foundation. */
    static func header(_ name: String, in response: HTTPURLResponse) -> String? {
        for (k, v) in response.allHeaderFields {
            if let key = k as? String, key.caseInsensitiveCompare(name) == .orderedSame { return v as? String ?? "\(v)" }
        }
        return nil
    }

    enum Method: String { case get = "GET", post = "POST" }

    /** Percent-encodes a single path segment (a "/" in an id must not create a new segment). */
    static func pathSegment(_ s: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#%")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    private func send<T: Decodable>(_ method: Method, _ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await send(method, path, query: query, body: nil, contentType: nil)
    }

    private func send<T: Decodable, B: Encodable>(_ method: Method, _ path: String, json: B,
                                                  authenticated: Bool = true) async throws -> T {
        let body = try SideKiqqJSON.encoder().encode(json)
        return try await send(method, path, query: [], body: body, contentType: "application/json",
                              authenticated: authenticated)
    }

    private func send<T: Decodable>(_ method: Method, _ path: String, query: [URLQueryItem] = [], body: Data?,
                                    contentType: String?, authenticated: Bool = true) async throws -> T {
        let req = try makeRequest(method, path, query: query, authenticated: authenticated, body: body,
                                  contentType: contentType)
        let (data, http) = try await perform(req)
        try ensureOK(data, http)
        do {
            return try SideKiqqJSON.decoder().decode(T.self, from: data)
        } catch {
            throw SideKiqqAPIError.decoding("\(T.self): \(error)")
        }
    }

    /** For `{ "ok": true }` routes only the 2xx status matters (same as the Kotlin client). */
    private func sendOK(_ method: Method, _ path: String) async throws {
        let req = try makeRequest(method, path, query: [], authenticated: true, body: nil, contentType: nil)
        let (data, http) = try await perform(req)
        try ensureOK(data, http)
    }

    private func sendOK<B: Encodable>(_ method: Method, _ path: String, json: B) async throws {
        let req = try makeRequest(method, path, query: [], authenticated: true,
                                  body: try SideKiqqJSON.encoder().encode(json), contentType: "application/json")
        let (data, http) = try await perform(req)
        try ensureOK(data, http)
    }

    func makeRequest(_ method: Method, _ path: String, query: [URLQueryItem], authenticated: Bool, body: Data?,
                     contentType: String?, accept: String? = nil) throws -> URLRequest {
        let root = baseURL.absoluteString.hasSuffix("/") ? String(baseURL.absoluteString.dropLast()) : baseURL.absoluteString
        guard var comps = URLComponents(string: root + path) else {
            throw SideKiqqAPIError.invalidInput("Bad URL for \(path)")
        }
        if !query.isEmpty { comps.queryItems = query }
        guard let url = comps.url else { throw SideKiqqAPIError.invalidInput("Bad URL for \(path)") }
        var req = URLRequest(url: url)
        req.httpMethod = method.rawValue
        req.timeoutInterval = Self.requestTimeout
        if authenticated, let token = tokenProvider() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let accept { req.setValue(accept, forHTTPHeaderField: "Accept") }
        if let body {
            req.httpBody = body
            if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        }
        return req
    }

    private func perform(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<(Data, HTTPURLResponse), Error>) in
            let task = session.dataTask(with: req) { data, response, error in
                if let error {
                    cont.resume(throwing: SideKiqqAPIError.transport(error.localizedDescription))
                    return
                }
                guard let http = response as? HTTPURLResponse else {
                    cont.resume(throwing: SideKiqqAPIError.transport("No HTTP response"))
                    return
                }
                cont.resume(returning: (data ?? Data(), http))
            }
            task.resume()
        }
    }

    private func ensureOK(_ data: Data, _ http: HTTPURLResponse) throws {
        guard (200..<300).contains(http.statusCode) else {
            let parsed = try? SideKiqqJSON.decoder().decode(APIErrorBody.self, from: data)
            throw SideKiqqAPIError.http(status: http.statusCode, code: parsed?.code, message: parsed?.error,
                                        body: String(decoding: data, as: UTF8.self))
        }
    }
}
