import SwiftUI
import UIKit

@main
struct EavesyApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var phase
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environment(model)
                .tint(Ev.coat)
                .onOpenURL { url in
                    // eavesy://note, eavesy://photo, eavesy://screenshot. A link never starts the
                    // microphone: any page or app can open one. Recording starts from a tap,
                    // a Home Screen action or a shortcut the user ran.
                    if let action = url.host.flatMap(QuickAction.init(rawValue:)), action != .record { QuickActions.shared.run(action) }
                }
        }
        .onChange(of: phase) { _, phase in
            switch phase {
            case .active: model.becameActive()
            case .background: model.wentToBackground()
            default: break
            }
        }
    }
}

/// Home Screen quick actions (long-press the icon) arrive through the scene.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if let item = options.shortcutItem { SceneDelegate.run(item) }
        let configuration = UISceneConfiguration(name: nil, sessionRole: session.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(_ scene: UIWindowScene, performActionFor item: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(Self.run(item))
    }

    @discardableResult
    static func run(_ item: UIApplicationShortcutItem) -> Bool {
        guard let name = item.type.split(separator: ".").last, let action = QuickAction(rawValue: String(name)) else { return false }
        Task { @MainActor in QuickActions.shared.run(action) }
        return true
    }
}
