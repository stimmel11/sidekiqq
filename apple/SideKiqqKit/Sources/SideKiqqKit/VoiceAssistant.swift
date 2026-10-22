import Foundation

/** Where a voice turn's audio goes (AirPods, car, phone speaker). `speak` returns when speech has finished. */
public protocol VoiceOutput: Sendable {
    func speak(_ text: String) async
}

/**
 * The voice pipeline shared by the Talk button and the medallion relay. Port of
 * android/phone VoiceAssistant.kt:
 *
 *   PCM -> WAV -> /api/transcribe -> (pending draft confirmation?) -> /api/ask -> speak `spoken`
 *
 * Safety: nothing is sent unless `DraftConfirmation` returns `.confirmed`, i.e. the owner said exactly
 * "send it" within 30 s after hearing the read-back (recipient, subject, one-sentence body summary).
 * One deliberate difference from Android: the read-back comes from the real draft (`GET /api/drafts`),
 * not the action summary. If the draft can't be loaded, nothing is offered by voice and the owner is
 * told to review it in the app.
 */
public actor VoiceAssistant {
    public enum Outcome: Equatable, Sendable {
        /** The assistant answered. `awaitingConfirm` = a draft is waiting for "send it". */
        case answered(transcript: String, response: AskResponse, awaitingConfirm: Bool)
        case draftSent(draftId: String)
        case draftNotSent
        case nothingHeard
        case notPaired
        /** Another turn is still running; this one was ignored. */
        case busy
        case failed(String)
    }

    public static let minUtteranceMs: Int64 = 300
    public static let conversationIdle: TimeInterval = 5 * 60

    public static let notSent = "Okay, not sent. The draft is saved."
    public static let trouble = "Sorry, I'm having trouble reaching SideKiqq."
    public static let notPaired = "SideKiqq isn't paired yet. Open the app on your iPhone to pair."
    public static let didntCatch = "Sorry, I didn't catch that."
    public static let sent = "Sent."
    public static let sendFailed = "I couldn't send it. The draft is still saved in the app."
    public static let windowClosed = "The confirmation window closed, so I didn't send it. The draft is saved in the app."
    public static let typedSendIt = "Not sent. To send, say \"send it\" out loud after the read-back, or use Review and send."
    public static let reviewInApp ="I drafted it, but couldn't load it to read back. Review it in the app before sending."

    private let apiProvider: @Sendable () -> SideKiqqAPI?
    private var confirmation: DraftConfirmation
    private let now: @Sendable () -> Date
    private var conversations: [DeviceKind: (id: String, at: Date)] = [:]
    private var busy = false

    public init(api: @escaping @Sendable () -> SideKiqqAPI?,
                confirmation: DraftConfirmation = DraftConfirmation(),
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.apiProvider = api
        self.confirmation = confirmation
        self.now = now
    }

    public var isAwaitingConfirm: Bool { confirmation.isAwaiting }
    public var pendingDraftId: String? { confirmation.pending?.draftId }

    public func cancelPendingDraft() { confirmation.clear() }

    /** 16 kHz mono PCM16 LE from the mic or the medallion. */
    public func handleUtterance(pcm: Data, device: DeviceKind, output: VoiceOutput) async -> Outcome {
        guard WavEncoder.durationMs(pcmBytes: pcm.count) >= Self.minUtteranceMs else { return .nothingHeard }
        guard !busy else { return .busy }
        guard let api = apiProvider() else {
            await output.speak(Self.notPaired)
            return .notPaired
        }
        busy = true
        defer { busy = false }

        let text: String
        do {
            text = try await api.transcribe(wav: WavEncoder.encode(pcm: pcm)).trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            await output.speak(Self.trouble)
            return .failed("\(error)")
        }
        if text.isEmpty {
            if confirmation.pending != nil {
                confirmation.clear()
                await output.speak(Self.notSent)
                return .draftNotSent
            }
            await output.speak(Self.didntCatch)
            return .nothingHeard
        }
        return await runTurn(text: text, device: device, api: api, output: output)
    }

    /**
     * An already-transcribed (`spoken: true`) or typed (`spoken: false`) request.
     * Typed text never confirms a draft: the rule is a spoken "send it". Typing anything while a draft
     * is pending cancels it, like any other answer.
     */
    public func handleText(_ text: String, device: DeviceKind, output: VoiceOutput, spoken: Bool = true) async -> Outcome {
        guard !busy else { return .busy }
        guard let api = apiProvider() else {
            await output.speak(Self.notPaired)
            return .notPaired
        }
        busy = true
        defer { busy = false }
        if !spoken, confirmation.pending != nil {
            confirmation.clear()
            if DraftConfirmation.isSendIt(text) {
                await output.speak(Self.typedSendIt)
                return .draftNotSent
            }
        }
        return await runTurn(text: text, device: device, api: api, output: output)
    }

    private func runTurn(text: String, device: DeviceKind, api: SideKiqqAPI, output: VoiceOutput) async -> Outcome {
        // 1) A draft is waiting for confirmation: this utterance is the answer, nothing else.
        switch confirmation.evaluate(text) {
        case let .confirmed(draftId):
            do {
                try await api.approveDraft(id: draftId)
                await output.speak(Self.sent)
                return .draftSent(draftId: draftId)
            } catch {
                await output.speak(Self.sendFailed)
                return .failed("\(error)")
            }
        case .declined:
            await output.speak(Self.notSent)
            return .draftNotSent
        case .expired:
            // The window lapsed: the draft stays unsent. A late "send it" must not go to the brain as a question.
            if DraftConfirmation.isSendIt(text) {
                await output.speak(Self.windowClosed)
                return .draftNotSent
            }
        case .nothingPending:
            break
        }

        // 2) Normal question.
        let response: AskResponse
        do {
            response = try await api.ask(text: text, device: device, conversationId: conversationId(for: device))
        } catch {
            await output.speak(Self.trouble)
            return .failed("\(error)")
        }
        conversations[device] = (response.conversationId, now())

        let spoken = response.spoken.trimmingCharacters(in: .whitespacesAndNewlines)
        await output.speak(spoken.isEmpty ? response.reply : spoken)

        // 3) Only the first new draft can be confirmed by voice; others wait in the app (Android parity).
        guard let draftAction = response.draftActions.first else {
            return .answered(transcript: text, response: response, awaitingConfirm: false)
        }
        let draft: Draft?
        do {
            draft = try await api.pendingDrafts().first { $0.id == draftAction.id }
        } catch {
            draft = nil
        }
        guard let draft else {
            await output.speak(Self.reviewInApp)
            return .answered(transcript: text, response: response, awaitingConfirm: false)
        }
        await output.speak(DraftConfirmation.prompt(for: draft))
        // Start the 30 s window after the read-back has been spoken, so the owner gets all of it.
        confirmation.arm(draftId: draft.id, summary: DraftConfirmation.readback(for: draft))
        return .answered(transcript: text, response: response, awaitingConfirm: true)
    }

    private func conversationId(for device: DeviceKind) -> String? {
        guard let c = conversations[device] else { return nil }
        return now().timeIntervalSince(c.at) < Self.conversationIdle ? c.id : nil
    }
}
