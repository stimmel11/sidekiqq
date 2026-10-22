import AVFoundation
import SideKiqqKit

/**
 * Audio session routing. Mirrors Android's USAGE_ASSISTANT routing: replies go to AirPods / the car /
 * Bluetooth glasses when connected, otherwise the phone speaker.
 */
enum AudioRouting {
    /** Recording: Bluetooth HFP lets AirPods be the mic; A2DP is kept for output; speaker, not earpiece. */
    static func forListening() throws {
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.playAndRecord, mode: .default,
                          options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .duckOthers])
        try s.setActive(true)
    }

    /**
     * Speaking: high-quality A2DP output, ducking (not stopping) other audio. `.mixWithOthers` makes the
     * session mixable, which is what lets the app start audio from the background (Background Modes: audio)
     * when the medallion asks something. Unverified on hardware; see docs/APPLE.md.
     */
    static func forSpeaking() throws {
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.playback, mode: .spokenAudio, options: [.mixWithOthers, .duckOthers])
        try s.setActive(true)
    }

    static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /** Short description of where audio is going, for the Settings screen and VoiceOver. */
    static var currentOutputName: String {
        AVAudioSession.sharedInstance().currentRoute.outputs.first?.portName ?? "iPhone"
    }
}

enum CaptureError: LocalizedError {
    case micDenied, noInput, converter

    var errorDescription: String? {
        switch self {
        case .micDenied: return "Microphone access is off. Turn it on in Settings > SideKiqq."
        case .noInput: return "No microphone is available."
        case .converter: return "Couldn't set up audio conversion."
        }
    }
}

/**
 * Captures the mic with AVAudioEngine and converts it to the brain's contract format:
 * 16 kHz mono PCM16 little-endian (Int16 is little-endian on every iOS device).
 * The tap runs on a realtime audio thread, so state is behind a lock.
 */
final class AudioCapture: @unchecked Sendable {
    static let maxSeconds = 60

    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var pcm = Data()
    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(WavEncoder.sampleRate),
                                          channels: 1, interleaved: true)!

    static func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    func start() throws {
        guard AVAudioApplication.shared.recordPermission == .granted else { throw CaptureError.micDenied }
        try AudioRouting.forListening()
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else { throw CaptureError.noInput }
        guard let conv = AVAudioConverter(from: inFormat, to: outFormat) else { throw CaptureError.converter }
        lock.lock()
        converter = conv
        pcm = Data()
        lock.unlock()
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, _ in
            self?.append(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    /** Stops capture and returns the PCM16 bytes. */
    func stop() -> Data {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        lock.lock()
        defer { lock.unlock() }
        let out = pcm
        pcm = Data()
        converter = nil
        return out
    }

    var capturedSeconds: Double {
        lock.lock(); defer { lock.unlock() }
        return Double(pcm.count) / Double(WavEncoder.sampleRate * 2)
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard let converter, buffer.frameLength > 0 else { return }
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, out.frameLength > 0, let ch = out.int16ChannelData else { return }
        let maxBytes = Self.maxSeconds * WavEncoder.sampleRate * 2
        let n = min(Int(out.frameLength) * 2, maxBytes - pcm.count)
        if n > 0 { pcm.append(Data(bytes: ch[0], count: n)) }
    }
}

/**
 * Speaks replies. Default: on-device AVSpeechSynthesizer (instant, works offline).
 * Optional: the brain's voice via `POST /api/speak` (same voice as Reachy), falling back to the
 * on-device voice on any error, including 413 for long text.
 * `speak` returns when playback has finished, so the 30 s "send it" window starts after the read-back.
 */
@MainActor
final class Speaker: NSObject, VoiceOutput, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    private let synth = AVSpeechSynthesizer()
    private let clientProvider: @Sendable () -> SideKiqqClient?
    /** Utterances waiting to finish; the Bool is "played to the end". */
    private var waiting: [ObjectIdentifier: CheckedContinuation<Bool, Never>] = [:]
    private var player: AVAudioPlayer?
    private var playerDone: CheckedContinuation<Bool, Never>?

    /** Settings toggle: use the brain's TTS voice instead of the on-device one. */
    var useBrainVoice: Bool {
        get { UserDefaults.standard.bool(forKey: "speech.useBrainVoice") }
        set { UserDefaults.standard.set(newValue, forKey: "speech.useBrainVoice") }
    }

    private(set) var isSpeaking = false

    init(clientProvider: @escaping @Sendable () -> SideKiqqClient?) {
        self.clientProvider = clientProvider
        super.init()
        synth.delegate = self
    }

    /** Returns true only if the whole text was played (VoiceOutput contract). */
    @discardableResult
    func speak(_ text: String) async -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return true } // nothing to say; a draft read-back is never empty

        do {
            try AudioRouting.forSpeaking()
        } catch {
            return false // can't play audio right now (e.g. background start refused): nothing was heard
        }
        isSpeaking = true
        defer { isSpeaking = false }
        if useBrainVoice, let client = clientProvider(), let audio = try? await client.speak(text: t),
           let p = try? AVAudioPlayer(data: audio.wav) {
            return await play(p)
        }
        return await synthesize(t)
    }

    /** Barge-in: stop whatever is playing (the owner started talking again). Interrupted speech reports false. */
    func stop() {
        synth.stopSpeaking(at: .immediate)
        player?.stop()
        finishPlayer(completed: false)
    }

    private func synthesize(_ text: String) async -> Bool {
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: Locale.preferredLanguages.first ?? "en-US")
        u.rate = AVSpeechUtteranceDefaultSpeechRate
        let id = ObjectIdentifier(u)
        return await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            waiting[id] = c
            synth.speak(u)
        }
    }

    private func play(_ p: AVAudioPlayer) async -> Bool {
        // One player at a time: a previous caller still waiting is told its audio was cut off.
        player?.stop()
        finishPlayer(completed: false)
        player = p
        p.delegate = self
        return await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            playerDone = c
            if !p.play() { finishPlayer(completed: false) }
        }
    }

    private func finishPlayer(completed: Bool) {
        player = nil
        playerDone?.resume(returning: completed)
        playerDone = nil
    }

    private func finishUtterance(_ id: ObjectIdentifier, completed: Bool) {
        waiting.removeValue(forKey: id)?.resume(returning: completed)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.finishUtterance(id, completed: true) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.finishUtterance(id, completed: false) }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.finishPlayer(completed: flag) }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in self.finishPlayer(completed: false) }
    }
}
