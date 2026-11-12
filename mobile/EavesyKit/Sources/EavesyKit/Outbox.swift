import Foundation

/// Something captured on this phone. It is written here before the network is
/// trusted, and stays as the phone's own copy after it has synced.
public struct OutboxItem: Codable, Identifiable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable { case recording, note, photo, screenshot }

    public enum State: String, Codable, Sendable {
        /// Audio is still being captured.
        case recording
        /// Waiting to go up (or part-way up).
        case pending
        /// A recording that is up and being transcribed.
        case processing
        /// In the account.
        case synced
        /// The server refused it; `lastError` says why. Kept on the phone.
        case failed
    }

    public struct Segment: Codable, Sendable, Equatable {
        public var index: Int
        public var file: String
        public var startMs: Int
        public var durationMs: Int
        public var uploaded = false

        public init(index: Int, file: String, startMs: Int, durationMs: Int) {
            self.index = index
            self.file = file
            self.startMs = startMs
            self.durationMs = durationMs
        }
    }

    /// Also the id the server dedupes on (`clientSessionId` / `x-client-capture-id`).
    public var id: UUID
    public var kind: Kind
    public var title: String
    public var createdAt: Date
    public var state: State
    /// The note or image file, inside the item's folder.
    public var file: String?
    public var contentType: String?
    /// A note's text, or what the cloud wrote about a recording.
    public var text: String?
    public var segments: [Segment] = []
    public var durationMs = 0
    /// The meeting or capture id once the server has it.
    public var remoteId: String?
    public var finalized = false
    public var attempts = 0
    public var nextAttemptAt: Date?
    public var lastError: String?

    public init(id: UUID = UUID(), kind: Kind, title: String, createdAt: Date = Date(), state: State = .pending) {
        self.id = id
        self.kind = kind
        self.title = title
        self.createdAt = createdAt
        self.state = state
    }

    /// Still has work for the sync engine.
    public var needsSync: Bool { state == .recording || state == .pending || state == .processing }
}

/// The on-disk outbox: one folder per item holding `item.json` and its files.
/// Writes are atomic, so a kill mid-save leaves the previous copy.
public final class OutboxStore: @unchecked Sendable {
    public let root: URL
    private let lock = NSLock()
    private var cache: [UUID: OutboxItem] = [:]
    private var observers: [@Sendable () -> Void] = []

    public init(root: URL) throws {
        self.root = root
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let decoder = JSONDecoder()
        for folder in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] {
            guard let data = try? Data(contentsOf: folder.appendingPathComponent("item.json")),
                  var item = try? decoder.decode(OutboxItem.self, from: data) else { continue }
            // The app died while recording: what reached disk is the recording.
            if item.state == .recording { item.state = .pending }
            cache[item.id] = item
        }
    }

    public func folder(for id: UUID) -> URL {
        root.appendingPathComponent(id.uuidString.lowercased(), isDirectory: true)
    }

    public func fileURL(_ item: OutboxItem) -> URL? {
        item.file.map { folder(for: item.id).appendingPathComponent($0) }
    }

    /// Newest first.
    public var items: [OutboxItem] {
        lock.withLock { cache.values.sorted { $0.createdAt > $1.createdAt } }
    }

    public func item(_ id: UUID) -> OutboxItem? {
        lock.withLock { cache[id] }
    }

    public func save(_ item: OutboxItem) throws {
        let dir = folder(for: item.id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try JSONEncoder().encode(item).write(to: dir.appendingPathComponent("item.json"), options: .atomic)
        lock.withLock { cache[item.id] = item }
        notify()
    }

    /// Reads, changes and saves one item under the lock's ordering, so the
    /// recorder and the sync engine never overwrite each other's fields.
    @discardableResult
    public func update(_ id: UUID, _ change: (inout OutboxItem) -> Void) throws -> OutboxItem? {
        let updated: OutboxItem? = try lock.withLock {
            guard var item = cache[id] else { return nil }
            change(&item)
            try JSONEncoder().encode(item).write(to: folder(for: id).appendingPathComponent("item.json"), options: .atomic)
            cache[id] = item
            return item
        }
        if updated != nil { notify() }
        return updated
    }

    public func remove(_ id: UUID) {
        lock.withLock { _ = cache.removeValue(forKey: id) }
        try? FileManager.default.removeItem(at: folder(for: id))
        notify()
    }

    public func observe(_ observer: @escaping @Sendable () -> Void) {
        lock.withLock { observers.append(observer) }
    }

    private func notify() {
        let current = lock.withLock { observers }
        current.forEach { $0() }
    }
}

public extension OutboxStore {
    /// Saves a note as Markdown, ready to sync.
    @discardableResult
    func addNote(_ text: String, at date: Date = Date()) throws -> OutboxItem {
        var item = OutboxItem(kind: .note, title: Self.noteTitle(text), createdAt: date)
        item.file = "note.md"
        item.contentType = "text/markdown"
        item.text = text
        try FileManager.default.createDirectory(at: folder(for: item.id), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: folder(for: item.id).appendingPathComponent("note.md"), options: .atomic)
        try save(item)
        return item
    }

    /// Saves image bytes (a photo or a screenshot), ready to sync.
    @discardableResult
    func addImage(_ data: Data, contentType: String, kind: OutboxItem.Kind, at date: Date = Date()) throws -> OutboxItem {
        let ext = ["image/png": "png", "image/heic": "heic", "image/webp": "webp", "image/gif": "gif"][contentType] ?? "jpg"
        var item = OutboxItem(kind: kind, title: kind == .screenshot ? "Screenshot" : "Photo", createdAt: date)
        item.file = "image.\(ext)"
        item.contentType = contentType
        try FileManager.default.createDirectory(at: folder(for: item.id), withIntermediateDirectories: true)
        try data.write(to: folder(for: item.id).appendingPathComponent(item.file!), options: .atomic)
        try save(item)
        return item
    }

    /// A note is named after its first line, as on the Mac.
    static func noteTitle(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let cleaned = line.trimmingCharacters(in: CharacterSet(charactersIn: "#*-> ").union(.whitespaces))
        return cleaned.isEmpty ? "Note" : String(cleaned.prefix(80))
    }
}
