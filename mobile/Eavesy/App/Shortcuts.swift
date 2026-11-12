import AppIntents

// Each capture as an App Intent, so it can sit on the Action button, in
// Control Center, in Shortcuts and in Spotlight, and Siri can start it.

struct RecordIntent: AppIntent {
    static let title: LocalizedStringResource = "Record a voice note"
    static let description = IntentDescription("Opens Eavesy and starts recording.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        QuickActions.shared.run(.record)
        return .result()
    }
}

struct NoteIntent: AppIntent {
    static let title: LocalizedStringResource = "Jot a note"
    static let description = IntentDescription("Opens Eavesy on a new note.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        QuickActions.shared.run(.note)
        return .result()
    }
}

struct PhotoIntent: AppIntent {
    static let title: LocalizedStringResource = "Take a picture"
    static let description = IntentDescription("Opens Eavesy's camera.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        QuickActions.shared.run(.photo)
        return .result()
    }
}

struct ScreenshotIntent: AppIntent {
    static let title: LocalizedStringResource = "Save a screenshot"
    static let description = IntentDescription("Opens Eavesy on your recent screenshots.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        QuickActions.shared.run(.screenshot)
        return .result()
    }
}

struct EavesyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: RecordIntent(), phrases: ["Record with \(.applicationName)", "Start a \(.applicationName) voice note"], shortTitle: "Record", systemImageName: "mic.fill")
        AppShortcut(intent: NoteIntent(), phrases: ["Jot a note in \(.applicationName)"], shortTitle: "Note", systemImageName: "square.and.pencil")
        AppShortcut(intent: PhotoIntent(), phrases: ["Take a picture with \(.applicationName)"], shortTitle: "Picture", systemImageName: "camera.fill")
        AppShortcut(intent: ScreenshotIntent(), phrases: ["Save a screenshot to \(.applicationName)"], shortTitle: "Screenshot", systemImageName: "rectangle.dashed.badge.record")
    }
}
