import SwiftUI
import UIKit
import UserNotifications
import BackgroundTasks

@main
struct SideKiqqApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appDelegate.model)
                .tint(SideKiqqTheme.Palette.accentInk)
        }
        .onChange(of: scenePhase) { _, phase in
            let model = appDelegate.model
            switch phase {
            case .active:
                model.alerts.start()
            case .background:
                model.alerts.stop()
                AlertPoller.scheduleAppRefresh()
            default:
                break
            }
        }
        // Background refresh: poll /api/alerts until the brain can push through APNs.
        .backgroundTask(.appRefresh(AlertPoller.refreshTaskID)) {
            AlertPoller.scheduleAppRefresh()
            await AppModel.backgroundRefresh()
        }
    }
}

/**
 * Creates the model at launch (before any scene) so that when iOS relaunches the app in the
 * background for a medallion BLE event, the CoreBluetooth central is recreated with the same
 * restore identifier and receives `willRestoreState`.
 */
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let model = AppModel()

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        model.launch()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await model.push.didRegister(deviceToken: deviceToken, client: model.client) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        model.push.didFail(error)
    }

    // Show alert banners while the app is open too.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}
