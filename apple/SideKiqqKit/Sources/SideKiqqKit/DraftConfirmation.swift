import Foundation

/**
 * Strict voice confirmation for sending drafts (ARCHITECTURE.md safety rules).
 * Port of android/phone DraftConfirmation.kt, same rules:
 *
 *  - Only one draft can be pending at a time, and only for `window` (30 s) after it was offered.
 *  - Only an exact "send it" (after normalizing case, punctuation and whitespace) confirms.
 *    "don't send it", "send it later", "yes" and "sure" do NOT confirm.
 *  - Any other utterance, or the window running out, cancels. The draft stays unsent on the server.
 *  - One shot: any answer consumes the pending draft, so a later "send it" can't resurrect it.
 *
 * Pure logic with an injectable clock. A `.confirmed` decision is the only thing that may lead to
 * `SideKiqqClient.approveDraft(id:)` from voice.
 */
public struct DraftConfirmation: Sendable {
    public struct Pending: Equatable, Sendable {
        public var draftId: String
        public var summary: String
        public var offeredAt: Date
        /** `fingerprint(of:)` of the draft as it was read back, so a later edit can be detected before sending. */
        public var fingerprint: String?
    }

    public enum Decision: Equatable, Sendable {
        case confirmed(draftId: String)
        case declined
        case expired
        case nothingPending
    }

    public static let defaultWindow: TimeInterval = 30

    public let window: TimeInterval
    private let now: @Sendable () -> Date
    public private(set) var pending: Pending?

    public init(window: TimeInterval = DraftConfirmation.defaultWindow, now: @escaping @Sendable () -> Date = { Date() }) {
        self.window = window
        self.now = now
    }

    /** Arms the confirmation for `draftId` starting now and returns the sentence to speak (Android parity). */
    @discardableResult
    public mutating func offer(draftId: String, summary: String) -> String {
        arm(draftId: draftId, summary: summary)
        return Self.promptFor(summary: summary)
    }

    /**
     * Arms the confirmation for a draft fetched from `/api/drafts`, returning the full read-back prompt
     * (recipient, subject, one-sentence body summary). Call it right AFTER the read-back has been spoken
     * (or use `arm`) so the owner gets the whole 30 s.
     */
    @discardableResult
    public mutating func offer(_ draft: Draft) -> String {
        arm(draft)
        return Self.prompt(for: draft)
    }

    /** Starts the 30 s window now. */
    public mutating func arm(draftId: String, summary: String, fingerprint: String? = nil) {
        pending = Pending(draftId: draftId, summary: summary, offeredAt: now(), fingerprint: fingerprint)
    }

    /** Starts the 30 s window now for a draft that was just read back. */
    public mutating func arm(_ draft: Draft) {
        arm(draftId: draft.id, summary: Self.readback(for: draft), fingerprint: Self.fingerprint(of: draft))
    }

    /** Identity of what the owner heard/saw: recipients, cc, subject and body. */
    public static func fingerprint(of draft: Draft) -> String {
        ([draft.to.joined(separator: "\u{1F}"), draft.cc.joined(separator: "\u{1F}"), draft.subject, draft.body])
            .joined(separator: "\u{1E}")
    }

    /**
     * - Parameter spokenAt: when the owner started speaking this answer. Speech that started before the
     *   window opened (over the read-back, or queued behind it) answers nothing the owner heard, so it
     *   declines. `nil` means "not spoken" (typed, or unknown) and also declines: this fails closed.
     */
    public mutating func evaluate(_ transcript: String, spokenAt: Date?) -> Decision {
        guard let p = pending else { return .nothingPending }
        pending = nil // one shot: any answer consumes the pending draft
        if now().timeIntervalSince(p.offeredAt) > window { return .expired }
        guard let spokenAt, spokenAt >= p.offeredAt else { return .declined }
        return Self.isSendIt(transcript) ? .confirmed(draftId: p.draftId) : .declined
    }

    public mutating func clear() { pending = nil }

    /** True when a draft is pending and its window hasn't lapsed. */
    public var isAwaiting: Bool {
        guard let p = pending else { return false }
        return now().timeIntervalSince(p.offeredAt) <= window
    }

    // MARK: - Phrase matching

    private static let accepted: Set<String> = ["send it"]

    /** Lowercase; anything but a-z, 0-9, apostrophe and space becomes a space; collapse and trim. */
    public static func normalize(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for u in s.lowercased().unicodeScalars {
            let keep = (u >= "a" && u <= "z") || (u >= "0" && u <= "9") || u == "'" || u == " "
            out.append(keep ? u : " ")
        }
        return String(out).split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
    }

    public static func isSendIt(_ transcript: String) -> Bool { accepted.contains(normalize(transcript)) }

    // MARK: - Spoken text

    public static let confirmInstruction = "Say 'send it' to confirm, or anything else to cancel."

    /** Same sentence as the Android client for a bare action summary. */
    public static func promptFor(summary: String) -> String {
        var s = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = s.last, ".?!".contains(last) { s.removeLast() }
        return "Send this: \(s)? \(confirmInstruction)"
    }

    /** Read-back plus the instruction, e.g. "Email to Dana Smith. Subject: Proposal. It says: ... Say 'send it' ..." */
    public static func prompt(for draft: Draft) -> String {
        "\(readback(for: draft)) \(confirmInstruction)"
    }

    /** Recipient, subject and a one-sentence body summary, for speaking. */
    public static func readback(for draft: Draft) -> String {
        var parts = ["Email to \(spokenRecipients(draft.to))"]
        if !draft.cc.isEmpty { parts[0] += ", copying \(spokenRecipients(draft.cc))" }
        let subject = draft.subject.trimmingCharacters(in: .whitespacesAndNewlines)
        parts.append("Subject: \(subject.isEmpty ? "no subject" : stripTrailingPunctuation(subject))")
        let summary = bodySummary(draft.body)
        parts.append(summary.isEmpty ? "The message is empty" : "It says: \(stripTrailingPunctuation(summary))")
        return parts.joined(separator: ". ") + "."
    }

    /** "Dana Smith <dana@acme.com>" -> "Dana Smith"; several -> "A, B and C". */
    public static func spokenRecipients(_ list: [String]) -> String {
        let names: [String] = list.map { raw in
            let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if let lt = t.firstIndex(of: "<") {
                let name = t[..<lt].trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
                if !name.isEmpty { return name }
                return String(t[t.index(after: lt)...]).trimmingCharacters(in: CharacterSet(charactersIn: "> "))
            }
            return t
        }.filter { !$0.isEmpty }
        switch names.count {
        case 0: return "no recipient"
        case 1: return names[0]
        default: return names.dropLast().joined(separator: ", ") + " and " + names.last!
        }
    }

    /**
     * First real sentence of the body: skips blank lines and a salutation line ("Hi Dana,"),
     * stops at the first ". ", "! " or "? ", and caps at `maxChars` on a word boundary.
     */
    public static func bodySummary(_ body: String, maxChars: Int = 160) -> String {
        var lines = body.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }
        while let first = lines.first, first.isEmpty || isSalutation(first) { lines.removeFirst() }
        let text = lines.filter { !$0.isEmpty }.joined(separator: " ")
        guard !text.isEmpty else { return "" }

        var sentence = text
        let chars = Array(text)
        for i in chars.indices where ".!?".contains(chars[i]) {
            if i == chars.count - 1 || chars[i + 1] == " " {
                sentence = String(chars[0...i])
                break
            }
        }
        if sentence.count > maxChars {
            let cut = String(sentence.prefix(maxChars))
            let trimmed = cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? cut
            sentence = trimmed + "…"
        }
        return sentence
    }

    static func isSalutation(_ line: String) -> Bool {
        let l = line.lowercased()
        if line.count <= 40 && line.hasSuffix(",") { return true }
        for g in ["hi", "hello", "hey", "dear", "good morning", "good afternoon"] where l == g || l.hasPrefix(g + " ") || l.hasPrefix(g + ",") {
            return line.count <= 40
        }
        return false
    }

    private static func stripTrailingPunctuation(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = t.last, ".?!".contains(last) { t.removeLast() }
        return t
    }
}
