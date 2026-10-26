import Foundation
import Observation
import SideKiqqKit

/** Holds the current client so non-main-actor code (the voice actor, BLE queue) can read it safely. */
final class ClientBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _client: SideKiqqClient?
    var client: SideKiqqClient? {
        get { lock.lock(); defer { lock.unlock() }; return _client }
        set { lock.lock(); _client = newValue; lock.unlock() }
    }
}

/**
 * App-wide state: pairing, the brain client, and the long-lived services (voice, medallion, alerts).
 *
 * SAFETY: `approveDraftConfirmed` is the app's only route to `POST /api/drafts/:id/approve` from the UI,
 * and it is called only from `DraftConfirmSheet`'s Send button. Voice approval happens inside
 * `VoiceAssistant` after an exact "send it" within 30 s of the read-back.
 */
@MainActor
@Observable
final class AppModel {
    private let store: TokenStore
    private let box: ClientBox

    private(set) var credentials: DeviceCredentials?
    var client: SideKiqqClient? { box.client }
    var isPaired: Bool { credentials != nil && box.client != nil }

    let speaker: Speaker
    let assistant: VoiceAssistant
    let voice: VoiceSession
    let medallionStatus: MedallionStatus
    let medallion: MedallionManager
    let alerts: AlertPoller
    let push: PushRegistrar

    init(store: TokenStore? = nil, push: PushRegistrar? = nil) {
        let store = store ?? KeychainTokenStore()
        self.store = store
        let box = ClientBox()
        self.box = box
        let status = MedallionStatus()
        self.medallionStatus = status
        let speaker = Speaker(clientProvider: { box.client })
        let assistant = VoiceAssistant(api: { box.client })
        self.speaker = speaker
        self.assistant = assistant
        self.voice = VoiceSession(assistant: assistant, speaker: speaker)
        let medallion = MedallionManager(assistant: assistant, speaker: speaker, status: status)
        self.medallion = medallion
        self.alerts = AlertPoller(clientProvider: { box.client }, medallion: medallion)
        // Until the brain supports APNs (docs/APPLE.md backlog) alerts come from polling + local notifications.
        self.push = push ?? LocalNotificationsOnly()
        loadCredentials()
        AppModel.current = self
    }

    /** The app's model, for entry points that have no environment (background tasks). */
    private(set) static weak var current: AppModel?

    /** BGAppRefreshTask entry point: fetch new alerts and post them as local notifications. */
    static func backgroundRefresh() async {
        await current?.alerts.pollOnce()
    }

    /** Called from `application(_:didFinishLaunchingWithOptions:)`. */
    func launch() {
        // Recreate the BLE central immediately if the owner turned the medallion on (state restoration).
        if medallion.isEnabled { medallion.start() }
    }

    private func loadCredentials() {
        credentials = store.load()
        if let c = credentials, let url = URL(string: c.baseURL), !c.token.isEmpty {
            box.client = SideKiqqClient(baseURL: url, tokenProvider: { [store] in store.token() })
        } else {
            box.client = nil
        }
    }

    // MARK: - Pairing

    func pair(urlText: String, code: String) async throws {
        guard let url = SideKiqqClient.normalizeBaseURL(urlText) else {
            throw SideKiqqAPIError.invalidInput("Enter your SideKiqq brain address, like sidekiqq.vercel.app.")
        }
        let pairing = SideKiqqClient(baseURL: url, tokenProvider: { nil })
        let r = try await pairing.pair(code: code, device: .thisIPhone, name: "iPhone")
        try store.save(DeviceCredentials(baseURL: url.absoluteString, token: r.token, deviceId: r.deviceId, device: r.device))
        loadCredentials()
        await push.requestAuthorizationAndRegister()
        alerts.start()
    }

    func unpair() {
        alerts.stop()
        medallion.stop()
        Task { await assistant.cancelPendingDraft() }
        try? store.clear()
        AlertPoller.resetCursor()
        loadCredentials()
    }

    // MARK: - Drafts

    /** Looks up a pending draft (recipients, subject, body) for the confirm sheet. Nil if it is no longer pending. */
    func pendingDraft(id: String) async throws -> Draft? {
        guard let client else { return nil }
        return try await client.pendingDrafts().first { $0.id == id }
    }

    /** Sends a draft. ONLY call from DraftConfirmSheet's Send button. */
    func approveDraftConfirmed(_ draft: Draft) async throws {
        guard let client else { throw SideKiqqAPIError.invalidInput("Not paired") }
        try await client.approveDraft(id: draft.id)
        // A voice confirmation pending for the same draft must not fire again.
        let pendingId = await assistant.pendingDraftId
        if pendingId == draft.id { await assistant.cancelPendingDraft() }
    }
}
