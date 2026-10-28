import Foundation

/*
 * Swift mirrors of the brain's contract models (ARCHITECTURE.md, brain/src/lib/models.ts).
 * Property names match the JSON keys exactly (the API is camelCase), so the default
 * JSONDecoder/JSONEncoder key strategy is used. Optional TS fields are Swift optionals and are
 * omitted (not sent as null) when encoding, matching the Kotlin client's `explicitNulls = false`.
 *
 * Dates stay as the ISO-8601 strings the brain sends, so a decode/encode round trip is lossless;
 * use `SideKiqqDate.parse(_:)` or the `...Date` helpers to get a `Date`.
 *
 * Closed sets in the brain's zod schemas (importance, confidence, status) are Swift enums.
 * Sets that are expected to grow (device kinds, action types, alert kinds) are open string
 * wrappers so a newer brain never breaks an older app.
 */

// MARK: - Enums (closed sets)

public enum Importance: String, Codable, CaseIterable, Sendable, Comparable {
    case critical = "CRITICAL"
    case high = "HIGH"
    case medium = "MEDIUM"
    case low = "LOW"
    case fyi = "FYI"

    /** Display label from design/tokens.json (`importance.*.label`). */
    public var label: String {
        switch self {
        case .critical: return "Critical"
        case .high: return "High"
        case .medium: return "Medium"
        case .low: return "Low"
        case .fyi: return "FYI"
        }
    }

    /** 4 = CRITICAL ... 0 = FYI. */
    public var rank: Int {
        switch self {
        case .critical: return 4
        case .high: return 3
        case .medium: return 2
        case .low: return 1
        case .fyi: return 0
        }
    }

    public static func < (lhs: Importance, rhs: Importance) -> Bool { lhs.rank < rhs.rank }
}

public enum Confidence: String, Codable, CaseIterable, Sendable {
    case confirmed = "CONFIRMED"
    case likely = "LIKELY"
    case inferred = "INFERRED"
    case unknown = "UNKNOWN"
}

/** Status carried on a `Commitment` payload. */
public enum CommitmentStatus: String, Codable, CaseIterable, Sendable {
    case open, done, overdue
}

/** `GET /api/commitments?status=` filter. `all` never appears in a payload. */
public enum CommitmentFilter: String, CaseIterable, Sendable {
    case open, overdue, all
}

public enum SourceKind: String, Codable, CaseIterable, Sendable {
    case email, meeting, voice
}

public enum BriefKind: String, Codable, CaseIterable, Sendable {
    case daily, eod, weekly
}

/** Voices accepted by `POST /api/speak` (brain `TTS_VOICES`). */
public enum SpeakVoice: String, Codable, CaseIterable, Sendable {
    case alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse
}

// MARK: - Open string sets

/**
 * Device kind. The brain accepts "watch", "glasses", "medallion", "phone", "reachy".
 * The iPhone pairs as `.phone` until the brain adds an `iphone` kind (see docs/APPLE.md).
 */
public struct DeviceKind: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
    public var description: String { rawValue }

    public static let watch: DeviceKind = "watch"
    public static let glasses: DeviceKind = "glasses"
    public static let medallion: DeviceKind = "medallion"
    public static let phone: DeviceKind = "phone"
    public static let reachy: DeviceKind = "reachy"

    /**
     * The kind this iPhone app uses for pairing and `/api/ask`. Today's brain has no `iphone` kind,
     * so it is `.phone`. Switch to `"iphone"` once the brain backlog item lands.
     */
    public static let thisIPhone: DeviceKind = .phone
}

public struct ActionType: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    public static let draftCreated: ActionType = "draft_created"
    public static let commitmentAdded: ActionType = "commitment_added"
    public static let eventProposed: ActionType = "event_proposed"
}

public struct AlertKind: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    public static let email: AlertKind = "email"
    public static let commitmentOverdue: AlertKind = "commitment_overdue"
}

// MARK: - Contract models

public struct CommitmentSource: Codable, Hashable, Sendable {
    public var kind: SourceKind
    public var ref: String?
    public init(kind: SourceKind, ref: String? = nil) {
        self.kind = kind
        self.ref = ref
    }
}

public struct Commitment: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var who: String
    public var what: String
    public var madeAt: String
    public var dueAt: String?
    public var dueInferred: Bool
    public var status: CommitmentStatus
    public var client: String?
    public var project: String?
    public var source: CommitmentSource
    public var confidence: Confidence

    public init(id: String, who: String, what: String, madeAt: String, dueAt: String? = nil, dueInferred: Bool = false,
                status: CommitmentStatus, client: String? = nil, project: String? = nil,
                source: CommitmentSource, confidence: Confidence) {
        self.id = id; self.who = who; self.what = what; self.madeAt = madeAt; self.dueAt = dueAt
        self.dueInferred = dueInferred; self.status = status; self.client = client; self.project = project
        self.source = source; self.confidence = confidence
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        who = try c.decode(String.self, forKey: .who)
        what = try c.decode(String.self, forKey: .what)
        madeAt = try c.decode(String.self, forKey: .madeAt)
        dueAt = try c.decodeIfPresent(String.self, forKey: .dueAt)
        dueInferred = try c.decodeIfPresent(Bool.self, forKey: .dueInferred) ?? false
        status = try c.decode(CommitmentStatus.self, forKey: .status)
        client = try c.decodeIfPresent(String.self, forKey: .client)
        project = try c.decodeIfPresent(String.self, forKey: .project)
        source = try c.decode(CommitmentSource.self, forKey: .source)
        confidence = try c.decode(Confidence.self, forKey: .confidence)
    }

    /** True when the due date or the commitment itself is a guess; the UI must say "inferred". */
    public var isInferred: Bool { dueInferred || confidence == .inferred }
    public var dueDate: Date? { dueAt.flatMap(SideKiqqDate.parse) }
}

public struct FollowUp: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var person: String
    public var client: String?
    public var reason: String
    public var daysQuiet: Int?
    public var importance: Importance
    public var suggestedMessage: String?
    public var draftId: String?

    public init(id: String, person: String, client: String? = nil, reason: String, daysQuiet: Int? = nil,
                importance: Importance, suggestedMessage: String? = nil, draftId: String? = nil) {
        self.id = id; self.person = person; self.client = client; self.reason = reason; self.daysQuiet = daysQuiet
        self.importance = importance; self.suggestedMessage = suggestedMessage; self.draftId = draftId
    }
}

public struct TopItem: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var why: String
    public var importance: Importance
    public var dueAt: String?

    public init(id: String, title: String, why: String, importance: Importance, dueAt: String? = nil) {
        self.id = id; self.title = title; self.why = why; self.importance = importance; self.dueAt = dueAt
    }
}

public struct Action: Codable, Hashable, Sendable, Identifiable {
    public var type: ActionType
    public var id: String
    public var summary: String

    public init(type: ActionType, id: String, summary: String) {
        self.type = type; self.id = id; self.summary = summary
    }
}

public struct BriefSection: Codable, Hashable, Sendable {
    public var title: String
    public var items: [String]

    public init(title: String, items: [String] = []) {
        self.title = title; self.items = items
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decode(String.self, forKey: .title)
        items = try c.decodeIfPresent([String].self, forKey: .items) ?? []
    }
}

public struct Brief: Codable, Hashable, Sendable {
    public var kind: BriefKind
    public var generatedAt: String
    public var sections: [BriefSection]
    public var top5: [TopItem]

    public init(kind: BriefKind, generatedAt: String, sections: [BriefSection] = [], top5: [TopItem] = []) {
        self.kind = kind; self.generatedAt = generatedAt; self.sections = sections; self.top5 = top5
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(BriefKind.self, forKey: .kind)
        generatedAt = try c.decode(String.self, forKey: .generatedAt)
        sections = try c.decodeIfPresent([BriefSection].self, forKey: .sections) ?? []
        top5 = try c.decodeIfPresent([TopItem].self, forKey: .top5) ?? []
    }
}

public struct AskResponse: Codable, Hashable, Sendable {
    public var reply: String
    public var spoken: String
    public var conversationId: String
    public var actions: [Action]

    public init(reply: String, spoken: String, conversationId: String, actions: [Action] = []) {
        self.reply = reply; self.spoken = spoken; self.conversationId = conversationId; self.actions = actions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reply = try c.decode(String.self, forKey: .reply)
        spoken = try c.decode(String.self, forKey: .spoken)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        actions = try c.decodeIfPresent([Action].self, forKey: .actions) ?? []
    }

    public var draftActions: [Action] { actions.filter { $0.type == .draftCreated } }
}

public struct Top5Response: Codable, Hashable, Sendable {
    public var items: [TopItem]
    public var updatedAt: String

    public init(items: [TopItem], updatedAt: String) {
        self.items = items; self.updatedAt = updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([TopItem].self, forKey: .items) ?? []
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
    }
}

/**
 * A pending draft from `GET /api/drafts` (brain extension route). This is what the confirm sheet
 * and the voice read-back show: recipients, subject and body.
 */
public struct Draft: Codable, Hashable, Sendable, Identifiable {
    /** Start and end (ISO-8601) of a calendar draft. */
    public struct When: Codable, Hashable, Sendable {
        public var start: String
        public var end: String
        public init(start: String, end: String) { self.start = start; self.end = end }
    }

    public var id: String
    /** "email", "calendar_invite" or "calendar_hold"; a plain string so new kinds can't break decoding. Absent = "email". */
    public var kind: String
    public var to: [String]
    public var cc: [String]
    public var subject: String
    public var body: String
    /**
     * One sentence the brain builds in code (every recipient address in full, the subject, the
     * time for calendar kinds). Empty from older brains.
     */
    public var readback: String
    /** Calendar kinds only. */
    public var when: When?
    public var client: String?
    public var createdAt: String

    public init(id: String, kind: String = "email", to: [String], cc: [String] = [], subject: String, body: String,
                readback: String = "", when: When? = nil, client: String? = nil, createdAt: String) {
        self.id = id; self.kind = kind; self.to = to; self.cc = cc; self.subject = subject; self.body = body
        self.readback = readback; self.when = when; self.client = client; self.createdAt = createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "email"
        to = try c.decode([String].self, forKey: .to)
        cc = try c.decodeIfPresent([String].self, forKey: .cc) ?? []
        subject = try c.decode(String.self, forKey: .subject)
        body = try c.decode(String.self, forKey: .body)
        readback = try c.decodeIfPresent(String.self, forKey: .readback) ?? ""
        when = try c.decodeIfPresent(When.self, forKey: .when)
        client = try c.decodeIfPresent(String.self, forKey: .client)
        createdAt = try c.decode(String.self, forKey: .createdAt)
    }
}

public struct Alert: Codable, Hashable, Sendable, Identifiable {
    /** Monotonic sequence number as a string; also the cursor. */
    public var id: String
    public var at: String
    public var title: String
    public var body: String
    public var kind: AlertKind
    public var importance: Importance?
    public var priority: String
    public var client: String?
    public var messageId: String?
    public var threadId: String?
    public var commitmentId: String?

    public init(id: String, at: String, title: String, body: String, kind: AlertKind, importance: Importance? = nil,
                priority: String, client: String? = nil, messageId: String? = nil, threadId: String? = nil,
                commitmentId: String? = nil) {
        self.id = id; self.at = at; self.title = title; self.body = body; self.kind = kind
        self.importance = importance; self.priority = priority; self.client = client
        self.messageId = messageId; self.threadId = threadId; self.commitmentId = commitmentId
    }

    /** HIGH/CRITICAL alerts buzz the medallion (CONTROL 0x12), like the Android push service. */
    public var needsAttention: Bool { importance == .critical || importance == .high }
}

public struct AlertsResponse: Codable, Hashable, Sendable {
    public var items: [Alert]
    public var cursor: String
    public var more: Bool

    public init(items: [Alert], cursor: String, more: Bool) {
        self.items = items; self.cursor = cursor; self.more = more
    }
}

// MARK: - Request / envelope types (wire only)

public struct AskRequest: Codable, Hashable, Sendable {
    public var text: String
    public var device: DeviceKind
    public var conversationId: String?

    public init(text: String, device: DeviceKind, conversationId: String? = nil) {
        self.text = text; self.device = device; self.conversationId = conversationId
    }
}

public struct TranscribeResponse: Codable, Hashable, Sendable {
    public var text: String
}

public struct ItemsResponse<T: Codable & Sendable>: Codable, Sendable {
    public var items: [T]

    public init(items: [T]) { self.items = items }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([T].self, forKey: .items) ?? []
    }

    private enum CodingKeys: String, CodingKey { case items }
}

public struct OkResponse: Codable, Hashable, Sendable {
    public var ok: Bool
}

public struct PairRequest: Codable, Hashable, Sendable {
    public var code: String
    public var device: DeviceKind
    public var name: String?

    public init(code: String, device: DeviceKind, name: String? = nil) {
        self.code = code; self.device = device; self.name = name
    }
}

public struct PairResponse: Codable, Hashable, Sendable {
    public var token: String
    public var deviceId: String
    public var device: DeviceKind

    public init(token: String, deviceId: String, device: DeviceKind) {
        self.token = token; self.deviceId = deviceId; self.device = device
    }
}

/** `POST /api/devices/register`. The field is named `fcmToken` by the contract; an APNs token goes here later. */
public struct RegisterDeviceRequest: Codable, Hashable, Sendable {
    public var fcmToken: String
    public var device: String

    public init(fcmToken: String, device: String) {
        self.fcmToken = fcmToken; self.device = device
    }
}

public struct SpeakRequest: Codable, Hashable, Sendable {
    public var text: String
    public var voice: SpeakVoice?

    public init(text: String, voice: SpeakVoice? = nil) {
        self.text = text; self.voice = voice
    }
}

/** Error body shape from brain/src/lib/http.ts `errorResponse`. */
public struct APIErrorBody: Codable, Hashable, Sendable {
    public var error: String?
    public var code: String?
}

// MARK: - Dates

public enum SideKiqqDate {
    // ISO8601DateFormatter is documented thread-safe on Apple platforms; on Linux (tests) access is sequential.
    nonisolated(unsafe) private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    nonisolated(unsafe) private static let dateOnly: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withFullDate]
        return f
    }()

    /** Parses the brain's ISO-8601 strings (`2026-10-22T15:04:05.123Z`, with or without fractional seconds, or a bare date). */
    public static func parse(_ s: String) -> Date? {
        withFraction.date(from: s) ?? plain.date(from: s) ?? dateOnly.date(from: s)
    }
}

/** The JSON coders used on the wire. */
public enum SideKiqqJSON {
    public static func decoder() -> JSONDecoder { JSONDecoder() }
    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }
}
