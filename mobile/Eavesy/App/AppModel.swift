import EavesyKit
import Network
import Observation
import SwiftUI
import UIKit

/// One thing the app can be asked to do the moment it opens.
enum QuickAction: String, Sendable {
    case record, note, photo, screenshot
}

/// Where a quick action waits between the system handing it over (a Home
/// Screen shortcut, the Action button, a link) and the app being ready for it.
@MainActor
final class QuickActions {
    static let shared = QuickActions()
    var handler: ((QuickAction) -> Void)?
    private var waiting: QuickAction?

    func run(_ action: QuickAction) {
        if let handler { handler(action) } else { waiting = action }
    }

    func attach(_ handler: @escaping (QuickAction) -> Void) {
        self.handler = handler
        if let waiting {
            self.waiting = nil
            handler(waiting)
        }
    }
}

/// A row in the library: something on this phone, or something from the account.
enum LibraryEntry: Identifiable {
    case local(OutboxItem)
    case session(RemoteSession)
    case capture(RemoteCapture)

    var id: String {
        switch self {
        case .local(let item): "local-\(item.id.uuidString)"
        case .session(let session): "session-\(session.id)"
        case .capture(let capture): "capture-\(capture.id)"
        }
    }

    var date: Date {
        switch self {
        case .local(let item): item.createdAt
        case .session(let session): Date(timeIntervalSince1970: session.startedAt / 1_000)
        case .capture(let capture): Date(timeIntervalSince1970: capture.createdAt / 1_000)
        }
    }
}

@MainActor
@Observable
final class AppModel {
    enum SignIn: Equatable {
        case idle
        case starting
        case waiting(URL)
        case failed(String)
    }

    let store: OutboxStore
    let base: URL
    let api: EavesyAPI
    private let engine: SyncEngine
    private let credentials = Credentials()
    private let tokenBox: TokenBox
    private let deviceId: UUID
    private let cacheURL: URL

    private(set) var items: [OutboxItem] = []
    private(set) var remoteSessions: [RemoteSession] = []
    private(set) var remoteCaptures: [RemoteCapture] = []
    private(set) var signedIn = false
    private(set) var account: Account?
    var signIn = SignIn.idle

    // Recording
    private var recorder: Recorder?
    private var startingRecording = false
    private(set) var recordingSince: Date?
    private(set) var level = 0.0
    var isRecording: Bool { recorder != nil }

    // What the capture screen should present next.
    var composingNote = false
    var takingPhoto = false
    var pickingScreenshot = false
    var notice: String?

    private var wake: Task<Void, Never>?
    private var pairing: Task<Void, Never>?
    private var live: Task<Void, Never>?
    private let path = NWPathMonitor()

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        // The outbox is this phone's copy of what it captured; never start without it.
        store = try! OutboxStore(root: support.appendingPathComponent("Outbox", isDirectory: true))
        cacheURL = support.appendingPathComponent("library.json")
        base = Self.apiBase()

        let defaults = UserDefaults.standard
        if let saved = defaults.string(forKey: "deviceId").flatMap(UUID.init(uuidString:)) {
            deviceId = saved
        } else {
            deviceId = UUID()
            defaults.set(deviceId.uuidString, forKey: "deviceId")
        }

        #if DEBUG
        // Local development has no Clerk to sign in with: `-deviceToken <token>` signs a debug build in.
        if let injected = UserDefaults.standard.string(forKey: "deviceToken") { credentials.save(token: injected, for: base) }
        #endif
        let box = TokenBox(credentials.token(for: base))
        tokenBox = box
        let api = EavesyAPI(base: base) { box.value }
        self.api = api
        engine = SyncEngine(store: store, api: api)
        signedIn = box.value != nil
        items = store.items
        loadCache()

        store.observe { [weak self] in
            Task { @MainActor in self?.items = self?.store.items ?? [] }
        }
        path.pathUpdateHandler = { [weak self] update in
            guard update.status == .satisfied else { return }
            Task { @MainActor in self?.sync() }
        }
        path.start(queue: .global(qos: .utility))
        QuickActions.shared.attach { [weak self] in self?.run($0) }
    }

    /// eavesy.com, or the server a debug build was pointed at (`-apiBase http://localhost:4173`).
    private static func apiBase() -> URL {
        #if DEBUG
        if let override = UserDefaults.standard.string(forKey: "apiBase"), let url = URL(string: override) { return url }
        #endif
        return URL(string: "https://eavesy.com")!
    }

    // MARK: Library

    /// Everything, newest first: this phone's captures, then the account's
    /// items that aren't already shown as one of them.
    var library: [LibraryEntry] {
        let localCaptureIds = Set(items.map { $0.id.uuidString.lowercased() })
        let localRemoteIds = Set(items.compactMap(\.remoteId))
        var entries = items.map(LibraryEntry.local)
        entries += remoteSessions.filter { !localRemoteIds.contains($0.id) }.map(LibraryEntry.session)
        entries += remoteCaptures
            .filter { !localRemoteIds.contains($0.id) && !localCaptureIds.contains($0.clientCaptureId?.lowercased() ?? "") }
            .map(LibraryEntry.capture)
        return entries.sorted { $0.date > $1.date }
    }

    var waitingToSync: Int { items.filter { $0.state == .pending }.count }

    func refresh() async {
        guard signedIn else { return }
        do {
            async let sessions = api.sessions()
            async let captures = api.captures()
            (remoteSessions, remoteCaptures) = try await (sessions, captures)
            saveCache()
            if account == nil { account = try? await api.account() }
        } catch APIError.unauthorized {
            tokenRejected()
        } catch {
            // Offline: the cached list stays on screen.
        }
    }

    private struct Cache: Codable {
        var sessions: [RemoteSession]
        var captures: [RemoteCapture]
        var account: Account?
    }

    private func loadCache() {
        guard signedIn, let data = try? Data(contentsOf: cacheURL), let cache = try? JSONDecoder().decode(Cache.self, from: data) else { return }
        remoteSessions = cache.sessions
        remoteCaptures = cache.captures
        account = cache.account
    }

    private func saveCache() {
        let cache = Cache(sessions: remoteSessions, captures: remoteCaptures, account: account)
        try? JSONEncoder().encode(cache).write(to: cacheURL, options: .atomic)
    }

    // MARK: Capture

    func run(_ action: QuickAction) {
        switch action {
        case .record: if !isRecording { Task { await startRecording() } }
        case .note: composingNote = true
        case .photo: takingPhoto = true
        case .screenshot: pickingScreenshot = true
        }
    }

    func startRecording() async {
        // Claimed before the first await, so two quick taps start one recording.
        guard recorder == nil, !startingRecording else { return }
        startingRecording = true
        defer { startingRecording = false }
        guard await Recorder.micAllowed() else {
            notice = Recorder.Failure.micDenied.localizedDescription
            return
        }
        do {
            let recorder = try Recorder(store: store)
            recorder.onLevel = { [weak self] in self?.level = $0 }
            recorder.onSegment = { [weak self] in self?.sync() }
            recorder.onInterrupted = { [weak self] in self?.stopRecording() }
            do {
                try recorder.start()
            } catch {
                store.remove(recorder.id)
                throw error
            }
            self.recorder = recorder
            recordingSince = recorder.startedAt
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        } catch {
            notice = (error as? LocalizedError)?.errorDescription ?? "Couldn't start recording."
        }
    }

    func stopRecording() {
        guard let recorder else { return }
        self.recorder = nil
        recordingSince = nil
        level = 0
        recorder.stop()
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        sync()
    }

    func saveNote(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        keep { try store.addNote(trimmed) }
    }

    func saveImage(_ data: Data, kind: OutboxItem.Kind) {
        keep { try store.addImage(data, contentType: ImageBytes.contentType(data), kind: kind) }
    }

    func discard(_ item: OutboxItem) {
        store.remove(item.id)
    }

    func retry(_ item: OutboxItem) {
        _ = try? store.update(item.id) {
            $0.state = $0.kind == .recording && $0.finalized ? .processing : .pending
            $0.attempts = 0
            $0.nextAttemptAt = nil
            $0.lastError = nil
        }
        sync()
    }

    private func keep(_ save: () throws -> OutboxItem) {
        do {
            _ = try save()
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            sync()
        } catch {
            notice = "Couldn't save that: this iPhone is out of space."
        }
    }

    /// Things shared into Eavesy from other apps wait in the app group's inbox.
    func importShared() {
        guard let inbox = SharedInbox.url,
              let files = try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: [.creationDateKey]) else { return }
        for file in files {
            guard let data = try? Data(contentsOf: file) else { continue }
            let date = (try? file.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date()
            do {
                if file.pathExtension == "txt" {
                    try store.addNote(String(decoding: data, as: UTF8.self), at: date)
                } else {
                    let type = ImageBytes.contentType(data)
                    // A PNG from the share sheet is almost always a screenshot.
                    try store.addImage(data, contentType: type, kind: type == "image/png" ? .screenshot : .photo, at: date)
                }
                try FileManager.default.removeItem(at: file)
            } catch {
                // Left in the inbox for the next launch.
            }
        }
        sync()
    }

    // MARK: Sync

    /// Sends whatever is waiting, then sleeps until the next retry or transcript
    /// check. A run already under way is never cut short: the engine folds this
    /// call into it.
    func sync() {
        guard signedIn else { return }
        wake?.cancel()
        Task { [engine] in
            let before = store.items.filter { $0.state == .synced }.count
            let outcome = await engine.drain()
            if outcome == .signedOut { return tokenRejected() }
            if store.items.filter({ $0.state == .synced }).count != before { await refresh() }
            guard let next = await engine.nextWake() else { return }
            wake?.cancel()
            wake = Task {
                try? await Task.sleep(for: .seconds(max(next.timeIntervalSinceNow, 1)))
                if !Task.isCancelled { sync() }
            }
        }
    }

    /// Keeps uploading for the short while iOS allows after the app leaves the screen.
    func finishInBackground() {
        guard signedIn, store.items.contains(where: \.needsSync) else { return }
        let app = UIApplication.shared
        let background = BackgroundTask()
        background.id = app.beginBackgroundTask { MainActor.assumeIsolated { background.end() } }
        Task { [engine] in
            _ = await engine.drain()
            background.end()
        }
    }

    func becameActive() {
        importShared()
        sync()
        Task { await refresh() }
        listenLive()
    }

    /// Hears at once when another device saves something, and refreshes.
    private func listenLive() {
        guard signedIn, live == nil else { return }
        live = Task { [api] in
            var delay = 2.0
            while !Task.isCancelled {
                do {
                    let socket = URLSession.shared.webSocketTask(with: try await api.liveSocketURL())
                    socket.resume()
                    defer { socket.cancel(with: .goingAway, reason: nil) }
                    while !Task.isCancelled {
                        _ = try await socket.receive()
                        delay = 2
                        await self.refresh()
                    }
                } catch APIError.unauthorized {
                    return self.tokenRejected()
                } catch {
                    try? await Task.sleep(for: .seconds(delay))
                    delay = min(delay * 2, 120)
                }
            }
        }
    }

    func wentToBackground() {
        live?.cancel()
        live = nil
        finishInBackground()
    }

    // MARK: Account

    /// Browser-approved sign-in, as on the Mac: ask for a code, open the
    /// approval page, wait for the token.
    func beginSignIn() {
        pairing?.cancel()
        signIn = .starting
        pairing = Task {
            do {
                let start = try await api.startPairing(deviceId: deviceId, name: "Eavesy for iPhone")
                // Only ever open the server we asked.
                let page = start.verificationUrl
                guard page.scheme == base.scheme, page.host == base.host, page.port == base.port else {
                    throw APIError.network("unexpected sign-in address")
                }
                signIn = .waiting(start.verificationUrl)
                let deadline = Date().addingTimeInterval(Double(start.expiresInSec))
                while Date() < deadline {
                    try await Task.sleep(for: .seconds(2))
                    let token: String?
                    do {
                        token = try await api.pairingToken(code: start.code, deviceId: deviceId)
                    } catch let error as APIError where error.isPermanent {
                        // The code expired or was refused: waiting longer won't help.
                        break
                    } catch {
                        continue
                    }
                    guard let token else { continue }
                    credentials.save(token: token, for: base)
                    tokenBox.value = token
                    signedIn = true
                    signIn = .idle
                    becameActive()
                    return
                }
                signIn = .failed("That sign-in link expired.")
            } catch is CancellationError {
                signIn = .idle
            } catch {
                signIn = .failed("Couldn't reach Eavesy. Check your connection.")
            }
        }
    }

    func cancelSignIn() {
        pairing?.cancel()
        pairing = nil
        signIn = .idle
    }

    func signOut() {
        // Revoke with the token in hand: forgetting the account clears the shared one.
        if let token = tokenBox.value {
            let revoke = EavesyAPI(base: base) { token }
            Task { try? await revoke.signOut() }
        }
        forgetAccount()
    }

    /// For screens that call the API themselves: a rejected token signs the app out.
    func loadFailed(_ error: Error) {
        if case APIError.unauthorized = error { tokenRejected() }
    }

    /// The server no longer knows this phone. Captures stay; sign in again to sync them.
    private func tokenRejected() {
        guard signedIn else { return }
        forgetAccount()
        notice = "You've been signed out. Your captures are still on this iPhone."
    }

    private func forgetAccount() {
        wake?.cancel()
        live?.cancel()
        live = nil
        credentials.clear()
        tokenBox.value = nil
        signedIn = false
        account = nil
        remoteSessions = []
        remoteCaptures = []
        try? FileManager.default.removeItem(at: cacheURL)
    }
}

/// The short while iOS allows after the app leaves the screen. Ended once,
/// whether the upload finished or iOS called time.
@MainActor
private final class BackgroundTask {
    var id = UIBackgroundTaskIdentifier.invalid

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

/// The token where a `@Sendable` closure can read it.
final class TokenBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: String?

    init(_ value: String?) {
        stored = value
    }

    var value: String? {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

/// The folder the share extension leaves things in.
enum SharedInbox {
    static let group = "group.com.eavesy.mobile"

    static var url: URL? {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        let inbox = container.appendingPathComponent("Inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        return inbox
    }
}
