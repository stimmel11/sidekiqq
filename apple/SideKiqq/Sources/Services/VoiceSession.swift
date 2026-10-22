import Foundation
import Observation
import SideKiqqKit

/**
 * The Talk button: tap to start, tap to stop (or 60 s cap).
 * AVAudioEngine capture -> WAV -> /api/transcribe -> /api/ask -> spoken reply (VoiceAssistant in SideKiqqKit).
 *
 * If the reply created a draft, VoiceAssistant reads back recipient, subject and a one-sentence summary;
 * the owner then taps Talk and says exactly "send it" within 30 s. Anything else cancels.
 */
@MainActor
@Observable
final class VoiceSession {
    enum Phase: Equatable {
        case idle, listening, thinking, speaking

        var label: String {
            switch self {
            case .idle: return "Ready"
            case .listening: return "Listening"
            case .thinking: return "Thinking"
            case .speaking: return "Speaking"
            }
        }
    }

    private(set) var phase: Phase = .idle
    private(set) var lastTranscript: String?
    private(set) var lastAnswer: AskResponse?
    private(set) var errorMessage: String?
    /** When a draft is waiting for a spoken "send it", the moment the window closes. */
    private(set) var confirmDeadline: Date?
    private(set) var pendingDraftId: String?

    private let assistant: VoiceAssistant
    private let speaker: Speaker
    private let capture = AudioCapture()
    private var capTask: Task<Void, Never>?
    private var listeningSince: Date?
    /** True while startListening awaits the mic permission, so a double tap can't start capture twice. */
    private var starting = false

    init(assistant: VoiceAssistant, speaker: Speaker) {
        self.assistant = assistant
        self.speaker = speaker
    }

    /**
     * One turn at a time: only `.idle` starts listening. Tapping while SideKiqq speaks just stops the
     * speech (barge-in); an interrupted draft read-back is not offered for "send it".
     */
    func toggle() {
        switch phase {
        case .idle:
            Task { await startListening() }
        case .listening:
            Task { await stopAndSend() }
        case .speaking:
            speaker.stop()
        case .thinking:
            break
        }
    }

    func startListening() async {
        guard phase == .idle, !starting else { return }
        starting = true
        defer { starting = false }
        errorMessage = nil
        guard await AudioCapture.requestPermission() else {
            errorMessage = CaptureError.micDenied.localizedDescription
            return
        }
        guard phase == .idle else { return }
        do {
            try capture.start()
            listeningSince = Date()
            phase = .listening
            capTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(AudioCapture.maxSeconds))
                guard !Task.isCancelled else { return }
                await self?.stopAndSend()
            }
        } catch {
            errorMessage = error.localizedDescription
            phase = .idle
        }
    }

    func stopAndSend() async {
        guard phase == .listening else { return }
        capTask?.cancel()
        capTask = nil
        let pcm = capture.stop()
        let startedAt = listeningSince ?? .distantPast // unknown start fails closed: can't confirm a draft
        listeningSince = nil
        phase = .thinking
        let outcome = await assistant.handleUtterance(pcm: pcm, device: .thisIPhone, output: PhaseOutput(session: self),
                                                      startedAt: startedAt)
        await finish(outcome)
    }

    /** Typed question. Typed text never confirms a draft (VoiceAssistant enforces it). */
    func ask(_ text: String) async {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, phase == .idle else { return }
        errorMessage = nil
        phase = .thinking
        // Typed text never confirms a draft (VoiceAssistant enforces it).
        let outcome = await assistant.handleTypedText(t, device: .thisIPhone, output: PhaseOutput(session: self))
        await finish(outcome)
    }

    func cancelPendingDraft() async {
        await assistant.cancelPendingDraft()
        confirmDeadline = nil
        pendingDraftId = nil
    }

    /** Called after a draft was sent from the confirm sheet so the answer no longer offers it. */
    func draftHandled(_ id: String) {
        guard var a = lastAnswer else { return }
        a.actions.removeAll { $0.id == id }
        lastAnswer = a
    }

    fileprivate func setPhase(_ p: Phase) {
        // Never let a running turn overwrite .listening (defensive; toggle() already serializes turns).
        if phase != .listening { phase = p }
    }
    fileprivate func say(_ text: String) async -> Bool { await speaker.speak(text) }

    private func finish(_ outcome: VoiceAssistant.Outcome) async {
        switch outcome {
        case let .answered(transcript, response, _):
            lastTranscript = transcript
            lastAnswer = response
        case .draftSent(let id):
            draftHandled(id)
        case .failed(let message):
            errorMessage = "Something went wrong: \(message)"
        case .notPaired:
            errorMessage = VoiceAssistant.notPaired
        case .nothingHeard, .draftNotSent, .busy:
            break
        }
        let awaiting = await assistant.isAwaitingConfirm
        if awaiting {
            pendingDraftId = await assistant.pendingDraftId
            confirmDeadline = Date().addingTimeInterval(DraftConfirmation.defaultWindow)
        } else {
            pendingDraftId = nil
            confirmDeadline = nil
        }
        phase = .idle
        // Capture only runs in .listening, which a finishing turn can't be in. Leave the session alone
        // if the medallion is speaking through the shared Speaker.
        if !speaker.isSpeaking { AudioRouting.deactivate() }
    }
}

/** Speaks through the shared Speaker and shows "Speaking" while it does. */
private struct PhaseOutput: VoiceOutput {
    let session: VoiceSession

    @discardableResult
    func speak(_ text: String) async -> Bool {
        await session.setPhase(.speaking)
        let completed = await session.say(text)
        await session.setPhase(.thinking)
        return completed
    }
}
