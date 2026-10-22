import BackgroundTasks
import Foundation
import SideKiqqKit
import UIKit
import UserNotifications

/**
 * Proactive alerts without APNs: polls `GET /api/alerts` (same content as the FCM pushes) every 60 s
 * while the app is open, and from a BGAppRefreshTask when it isn't, then posts local notifications.
 * HIGH/CRITICAL alerts also buzz the medallion (CONTROL 0x12), like the Android push service.
 * Notifications only open the app; they never carry a send action.
 */
@MainActor
final class AlertPoller {
    nonisolated static let refreshTaskID = "com.sidekiqq.alerts.refresh"
    private static let cursorKey = "alerts.cursor"
    private static let interval: Duration = .seconds(60)

    private let clientProvider: @Sendable () -> SideKiqqClient?
    private let medallion: MedallionManager
    private var loop: Task<Void, Never>?
    private var polling = false

    init(clientProvider: @escaping @Sendable () -> SideKiqqClient?, medallion: MedallionManager) {
        self.clientProvider = clientProvider
        self.medallion = medallion
    }

    func start() {
        guard loop == nil, clientProvider() != nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pollOnce()
                try? await Task.sleep(for: Self.interval)
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    static func resetCursor() { UserDefaults.standard.removeObject(forKey: cursorKey) }

    /** Asks iOS to wake the app for a refresh in ~15 min (iOS decides the real time). */
    nonisolated static func scheduleAppRefresh() {
        let req = BGAppRefreshTaskRequest(identifier: refreshTaskID)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }

    /**
     * Fetches new alerts. The very first poll after pairing only records the cursor (the brain returns
     * the last 24 h without one) so the owner isn't flooded with old notifications.
     */
    @discardableResult
    func pollOnce() async -> Int {
        guard !polling, let client = clientProvider() else { return 0 }
        polling = true
        defer { polling = false }
        let defaults = UserDefaults.standard
        var cursor = defaults.string(forKey: Self.cursorKey)
        let firstRun = cursor == nil
        var delivered = 0
        do {
            for _ in 0..<10 { // at most 10 pages per poll
                let page = try await client.alerts(since: cursor, limit: 50)
                if !firstRun {
                    for a in page.items { if await notify(a) { delivered += 1 } }
                }
                cursor = page.cursor
                defaults.set(page.cursor, forKey: Self.cursorKey)
                if !page.more { break }
            }
        } catch {
            // Offline or brain down: try again next time.
        }
        return delivered
    }

    private func notify(_ alert: SideKiqqKit.Alert) async -> Bool {
        if alert.needsAttention { medallion.signalNeedsAttention() }
        if alert.importance == .fyi { return false }
        let content = UNMutableNotificationContent()
        content.title = alert.title
        content.body = alert.body
        content.subtitle = alert.importance?.label ?? ""
        content.sound = alert.needsAttention ? .default : nil
        content.threadIdentifier = alert.client ?? alert.kind.rawValue
        content.userInfo = ["alertId": alert.id, "kind": alert.kind.rawValue]
        let req = UNNotificationRequest(identifier: "alert-\(alert.id)", content: content, trigger: nil)
        do {
            try await UNUserNotificationCenter.current().add(req)
            return true
        } catch {
            return false
        }
    }
}

/**
 * Push registration seam. Until the brain can deliver through APNs (docs/APPLE.md, brain backlog),
 * the app uses `LocalNotificationsOnly`: notification permission for the locally posted alerts above,
 * no remote registration. `APNsPushRegistrar` is ready for when the brain lands APNs.
 */
@MainActor
protocol PushRegistrar: AnyObject {
    func requestAuthorizationAndRegister() async
    func didRegister(deviceToken: Data, client: SideKiqqClient?) async
    func didFail(_ error: Error)
}

@MainActor
final class LocalNotificationsOnly: PushRegistrar {
    func requestAuthorizationAndRegister() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
    }

    func didRegister(deviceToken: Data, client: SideKiqqClient?) async {}
    func didFail(_ error: Error) {}
}

/**
 * Not used yet. Needs: the brain's APNs delivery + an `iphone` device kind, the Push Notifications
 * capability (aps-environment entitlement) and an APNs key in the Apple Developer account.
 */
@MainActor
final class APNsPushRegistrar: PushRegistrar {
    private(set) var lastError: String?

    func requestAuthorizationAndRegister() async {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() }
    }

    func didRegister(deviceToken: Data, client: SideKiqqClient?) async {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        // The contract's field is named fcmToken; the brain will tell APNs and FCM tokens apart by device kind.
        try? await client?.registerDevice(pushToken: hex, device: .thisIPhone)
    }

    func didFail(_ error: Error) { lastError = error.localizedDescription }
}
