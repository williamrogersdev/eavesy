import Foundation

/// Sends the outbox to the account. Every step is safe to repeat, so a crash,
/// a dropped connection or a second run picks up where the last one stopped.
public actor SyncEngine {
    public enum Outcome: Sendable, Equatable {
        case idle
        /// The device token no longer works: the user has to sign in again.
        case signedOut
    }

    private let store: OutboxStore
    private let api: EavesyAPI
    private let now: @Sendable () -> Date
    private var running = false
    private var again = false

    public init(store: OutboxStore, api: EavesyAPI, now: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store
        self.api = api
        self.now = now
    }

    /// Works through everything that is due. Calls made while one is running
    /// fold into a single follow-up pass.
    @discardableResult
    public func drain() async -> Outcome {
        if running {
            again = true
            return .idle
        }
        running = true
        defer { running = false }
        repeat {
            again = false
            // Oldest first, so things arrive in the order they were captured.
            for item in store.items.reversed() where item.needsSync {
                if let wait = item.nextAttemptAt, wait > now() { continue }
                do {
                    try await sync(item)
                } catch APIError.unauthorized {
                    return .signedOut
                } catch {
                    fail(item.id, error)
                }
            }
        } while again
        return .idle
    }

    /// When the next retry or transcript check is due, if any. A recording still
    /// being captured has nothing to wait for: each sealed segment asks for a run itself.
    public func nextWake() -> Date? {
        store.items.filter { $0.needsSync && $0.state != .recording }.map { $0.nextAttemptAt ?? now() }.min()
    }

    private func sync(_ item: OutboxItem) async throws {
        switch item.kind {
        case .note, .photo, .screenshot: try await syncCapture(item)
        case .recording: try await syncRecording(item)
        }
    }

    private func syncCapture(_ item: OutboxItem) async throws {
        guard let file = store.fileURL(item), let contentType = item.contentType else {
            try store.update(item.id) { $0.state = .failed; $0.lastError = "The file is missing." }
            return
        }
        let id = try await api.uploadCapture(clientId: item.id, file: file, contentType: contentType, title: item.title, capturedAt: item.createdAt)
        try store.update(item.id) {
            $0.remoteId = id
            $0.state = .synced
            $0.lastError = nil
            $0.nextAttemptAt = nil
        }
    }

    private func syncRecording(_ item: OutboxItem) async throws {
        var item = item
        if item.state == .recording {
            // Still capturing: send the minutes that are already sealed, so a
            // long recording is mostly up by the time it stops.
            guard item.segments.contains(where: { !$0.uploaded }) else { return }
            _ = try await uploadSegments(item)
            return
        }
        if item.state == .pending {
            if item.segments.isEmpty {
                try store.update(item.id) { $0.state = .failed; $0.lastError = "Nothing was recorded." }
                return
            }
            item = try await uploadSegments(item)
            guard let meetingId = item.remoteId else { return }
            try await api.finalize(meetingId: meetingId)
            item = try store.update(item.id) {
                $0.finalized = true
                $0.state = .processing
                $0.attempts = 0
                $0.lastError = nil
            } ?? item
        }
        guard item.state == .processing, let meetingId = item.remoteId else { return }
        let result = try await api.result(meetingId: meetingId)
        try store.update(item.id) {
            switch result.status {
            case "complete":
                // Until then the cloud's title is a placeholder.
                if let title = result.title, !title.isEmpty { $0.title = title }
                $0.state = .synced
                $0.text = result.summary?.tldr ?? result.transcript.map(\.text).joined(separator: " ")
                $0.nextAttemptAt = nil
            case "failed":
                $0.state = .failed
                $0.lastError = "Transcription failed. The audio is saved."
            default:
                // Still writing it down: look again soon, then less often.
                $0.attempts += 1
                $0.nextAttemptAt = now().addingTimeInterval(min(3 * Double($0.attempts), 30))
            }
        }
    }

    /// Creates the cloud recording if needed and sends every segment not yet up.
    private func uploadSegments(_ item: OutboxItem) async throws -> OutboxItem {
        var item = item
        if item.remoteId == nil {
            let meetingId = try await api.createSession(clientSessionId: item.id, title: nil, startedAt: item.createdAt)
            item = try store.update(item.id) { $0.remoteId = meetingId } ?? item
        }
        guard let meetingId = item.remoteId else { return item }
        for segment in item.segments where !segment.uploaded {
            let file = store.folder(for: item.id).appendingPathComponent(segment.file)
            try await api.uploadSegment(meetingId: meetingId, index: segment.index, file: file, startMs: segment.startMs, durationMs: segment.durationMs)
            item = try store.update(item.id) { stored in
                if let at = stored.segments.firstIndex(where: { $0.index == segment.index }) { stored.segments[at].uploaded = true }
            } ?? item
        }
        return item
    }

    private func fail(_ id: UUID, _ error: Error) {
        let permanent = (error as? APIError)?.isPermanent ?? false
        _ = try? store.update(id) {
            $0.lastError = Self.describe(error)
            if permanent {
                $0.state = .failed
            } else {
                $0.attempts += 1
                $0.nextAttemptAt = now().addingTimeInterval(Self.backoff($0.attempts))
            }
        }
    }

    /// 2 s doubling to 5 minutes, the Mac app's schedule.
    public static func backoff(_ attempts: Int) -> TimeInterval {
        min(2 * pow(2, Double(min(max(attempts, 1), 9) - 1)), 300)
    }

    static func describe(_ error: Error) -> String {
        switch error {
        case APIError.http(let status, let message): return message.isEmpty ? "The server said \(status)." : "\(message) (\(status))"
        case APIError.network: return "No connection. It will sync when you're back online."
        default: return "Couldn't sync. It will try again."
        }
    }
}
