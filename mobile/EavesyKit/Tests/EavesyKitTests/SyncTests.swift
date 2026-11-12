import XCTest
@testable import EavesyKit

/// Stands in for the server: records each request and answers from a script.
final class FakeServer: HTTPTransport, @unchecked Sendable {
    struct Call { let method: String; let path: String; let headers: [String: String]; let body: Data }

    private let lock = NSLock()
    private var recorded: [Call] = []
    var respond: @Sendable (Call) -> (Int, String) = { _ in (200, "{}") }

    var calls: [Call] { lock.withLock { recorded } }

    func send(_ request: URLRequest, body: HTTPBody) async throws -> (Data, HTTPURLResponse) {
        let bytes: Data
        switch body {
        case .none: bytes = Data()
        case .data(let data): bytes = data
        case .file(let url): bytes = try Data(contentsOf: url)
        }
        let url = request.url!
        let path = url.path + (url.query.map { "?\($0)" } ?? "")
        let call = Call(method: request.httpMethod ?? "GET", path: path, headers: Dictionary(uniqueKeysWithValues: (request.allHTTPHeaderFields ?? [:]).map { ($0.key.lowercased(), $0.value) }), body: bytes)
        lock.withLock { recorded.append(call) }
        let (status, text) = respond(call)
        if status == 0 { throw URLError(.notConnectedToInternet) }
        return (Data(text.utf8), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

final class SyncTests: XCTestCase {
    private var root: URL!
    private var store: OutboxStore!
    private var server: FakeServer!
    private var clock = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("eavesy-\(UUID().uuidString)")
        store = try OutboxStore(root: root)
        server = FakeServer()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
    }

    private func engine(token: String? = "eavesy_device_test") -> SyncEngine {
        let api = EavesyAPI(base: URL(string: "https://eavesy.test")!, transport: server) { token }
        let clock = self.clock
        return SyncEngine(store: store, api: api) { clock }
    }

    private func recording(segments: Int) throws -> OutboxItem {
        var item = OutboxItem(kind: .recording, title: "Voice note", createdAt: clock)
        try FileManager.default.createDirectory(at: store.folder(for: item.id), withIntermediateDirectories: true)
        for index in 0..<segments {
            let name = "segment-\(index).m4a"
            try Data("audio\(index)".utf8).write(to: store.folder(for: item.id).appendingPathComponent(name))
            item.segments.append(.init(index: index, file: name, startMs: index * 60_000, durationMs: 60_000))
        }
        try store.save(item)
        return item
    }

    func testNoteUploadsOnceWithItsIdAndTitle() async throws {
        let note = try store.addNote("# Ring the plumber\nbefore Friday", at: clock)
        server.respond = { _ in (201, #"{"id":"cap_1"}"#) }

        let outcome = await engine().drain()

        XCTAssertEqual(outcome, .idle)
        let call = try XCTUnwrap(server.calls.first)
        XCTAssertEqual(server.calls.count, 1)
        XCTAssertEqual(call.method, "POST")
        XCTAssertEqual(call.path, "/api/devices/captures")
        XCTAssertEqual(call.headers["content-type"], "text/markdown")
        XCTAssertEqual(call.headers["x-client-capture-id"], note.id.uuidString.lowercased())
        XCTAssertEqual(call.headers["x-title"], "Ring%20the%20plumber")
        XCTAssertEqual(call.headers["authorization"], "Bearer eavesy_device_test")
        XCTAssertEqual(String(decoding: call.body, as: UTF8.self), "# Ring the plumber\nbefore Friday")
        let saved = try XCTUnwrap(store.item(note.id))
        XCTAssertEqual(saved.state, .synced)
        XCTAssertEqual(saved.remoteId, "cap_1")

        // Nothing left to send.
        _ = await engine().drain()
        XCTAssertEqual(server.calls.count, 1)
    }

    func testOfflineKeepsTheItemAndBacksOff() async throws {
        let photo = try store.addImage(Data([0xFF, 0xD8]), contentType: "image/jpeg", kind: .photo, at: clock)
        server.respond = { _ in (0, "") }

        _ = await engine().drain()

        let saved = try XCTUnwrap(store.item(photo.id))
        XCTAssertEqual(saved.state, .pending)
        XCTAssertEqual(saved.attempts, 1)
        XCTAssertEqual(saved.nextAttemptAt, clock.addingTimeInterval(2))

        // Not due yet: no second request.
        _ = await engine().drain()
        XCTAssertEqual(server.calls.count, 1)

        // Due: it goes up.
        clock = clock.addingTimeInterval(3)
        server.respond = { _ in (200, #"{"id":"cap_2","idempotent":true}"#) }
        _ = await engine().drain()
        XCTAssertEqual(store.item(photo.id)?.state, .synced)
    }

    func testARefusedUploadIsKeptAndNotRetried() async throws {
        let shot = try store.addImage(Data([1]), contentType: "image/png", kind: .screenshot, at: clock)
        server.respond = { _ in (413, #"{"error":"image too large (50 MB max)"}"#) }

        _ = await engine().drain()
        _ = await engine().drain()

        XCTAssertEqual(server.calls.count, 1)
        let saved = try XCTUnwrap(store.item(shot.id))
        XCTAssertEqual(saved.state, .failed)
        XCTAssertEqual(saved.lastError, "image too large (50 MB max) (413)")
        XCTAssertNotNil(store.fileURL(saved).flatMap { try? Data(contentsOf: $0) })
    }

    func testARevokedTokenStopsTheRunAndLosesNothing() async throws {
        try store.addNote("one", at: clock)
        try store.addNote("two", at: clock.addingTimeInterval(1))
        server.respond = { _ in (401, #"{"error":"unauthenticated"}"#) }

        let outcome = await engine().drain()

        XCTAssertEqual(outcome, .signedOut)
        XCTAssertEqual(server.calls.count, 1)
        XCTAssertEqual(store.items.map(\.state), [.pending, .pending])
    }

    func testSignedOutSendsNothing() async throws {
        try store.addNote("kept on the phone", at: clock)
        let outcome = await engine(token: nil).drain()
        XCTAssertEqual(outcome, .signedOut)
        XCTAssertTrue(server.calls.isEmpty)
    }

    func testRecordingGoesUpInOrderThenWaitsForTheTranscript() async throws {
        let item = try recording(segments: 2)
        server.respond = { call in
            if call.path == "/api/sessions" { return (201, #"{"meetingId":"mtg_1"}"#) }
            if call.path.hasSuffix("/result") {
                return (200, #"{"meetingId":"mtg_1","status":"processing","title":null,"transcriptReady":false,"transcript":[],"summary":null}"#)
            }
            return (200, #"{"ok":true}"#)
        }

        _ = await engine().drain()

        XCTAssertEqual(server.calls.map { "\($0.method) \($0.path)" }, [
            "POST /api/sessions",
            "PUT /api/sessions/mtg_1/segments/0",
            "PUT /api/sessions/mtg_1/segments/1",
            "POST /api/sessions/mtg_1/finalize?archive=none",
            "GET /api/sessions/mtg_1/result",
        ])
        let create = try JSONSerialization.jsonObject(with: server.calls[0].body) as? [String: Any]
        XCTAssertEqual(create?["clientSessionId"] as? String, item.id.uuidString.lowercased())
        XCTAssertEqual(server.calls[2].headers["x-segment-start-ms"], "60000")
        XCTAssertEqual(server.calls[2].headers["x-segment-duration-ms"], "60000")
        XCTAssertEqual(server.calls[2].headers["x-segment-track"], "mic")
        XCTAssertEqual(String(decoding: server.calls[2].body, as: UTF8.self), "audio1")
        var saved = try XCTUnwrap(store.item(item.id))
        XCTAssertEqual(saved.state, .processing)
        XCTAssertNotNil(saved.nextAttemptAt)

        // Later the cloud has written it down.
        clock = clock.addingTimeInterval(60)
        server.respond = { _ in
            (200, #"{"meetingId":"mtg_1","status":"complete","title":"Plumber call","transcriptReady":true,"transcript":[{"startMs":0,"text":"Hello","rawText":"hello","speaker":null}],"summary":{"tldr":"Booked for Friday."}}"#)
        }
        _ = await engine().drain()
        saved = try XCTUnwrap(store.item(item.id))
        XCTAssertEqual(saved.state, .synced)
        XCTAssertEqual(saved.title, "Plumber call")
        XCTAssertEqual(saved.text, "Booked for Friday.")
    }

    func testAnInterruptedRecordingResumesWithoutResendingSegments() async throws {
        let item = try recording(segments: 3)
        server.respond = { call in
            if call.path == "/api/sessions" { return (201, #"{"meetingId":"mtg_2"}"#) }
            if call.path.hasSuffix("/segments/1") { return (0, "") }
            return (200, #"{"ok":true}"#)
        }
        _ = await engine().drain()
        XCTAssertEqual(store.item(item.id)?.segments.map(\.uploaded), [true, false, false])

        clock = clock.addingTimeInterval(10)
        server.respond = { call in
            call.path.hasSuffix("/result")
                ? (200, #"{"meetingId":"mtg_2","status":"processing","title":null,"transcriptReady":false,"transcript":[],"summary":null}"#)
                : (200, #"{"ok":true}"#)
        }
        _ = await engine().drain()

        let second = server.calls.dropFirst(3).map { "\($0.method) \($0.path)" }
        XCTAssertEqual(second, [
            "PUT /api/sessions/mtg_2/segments/1",
            "PUT /api/sessions/mtg_2/segments/2",
            "POST /api/sessions/mtg_2/finalize?archive=none",
            "GET /api/sessions/mtg_2/result",
        ])
    }

    func testSealedMinutesGoUpWhileStillRecording() async throws {
        var item = try recording(segments: 1)
        item.state = .recording
        try store.save(item)
        server.respond = { call in call.path == "/api/sessions" ? (201, #"{"meetingId":"mtg_3"}"#) : (202, #"{"ok":true}"#) }

        _ = await engine().drain()

        XCTAssertEqual(server.calls.map(\.path), ["/api/sessions", "/api/sessions/mtg_3/segments/0"])
        XCTAssertEqual(store.item(item.id)?.state, .recording)
    }

    func testNothingWakesTheEngineWhileARecordingIsOnlyBeingCaptured() async throws {
        var item = try recording(segments: 0)
        item.state = .recording
        try store.save(item)
        let wake = await engine().nextWake()
        XCTAssertNil(wake)

        // A note waiting on a retry still does.
        try store.addNote("later", at: clock)
        server.respond = { _ in (0, "") }
        let engine = engine()
        _ = await engine.drain()
        let retry = await engine.nextWake()
        XCTAssertEqual(retry, clock.addingTimeInterval(2))
    }

    func testTheOutboxSurvivesARestartAndClosesAnInterruptedRecording() throws {
        let note = try store.addNote("still here", at: clock)
        var live = OutboxItem(kind: .recording, title: "Voice note", createdAt: clock, state: .recording)
        live.segments = [.init(index: 0, file: "segment-0.m4a", startMs: 0, durationMs: 4_000)]
        try store.save(live)

        let reopened = try OutboxStore(root: root)

        XCTAssertEqual(reopened.item(note.id)?.text, "still here")
        XCTAssertEqual(reopened.item(live.id)?.state, .pending)
        XCTAssertEqual(reopened.item(live.id)?.segments.count, 1)
    }

    func testBackoffDoublesToFiveMinutes() {
        XCTAssertEqual(SyncEngine.backoff(1), 2)
        XCTAssertEqual(SyncEngine.backoff(2), 4)
        XCTAssertEqual(SyncEngine.backoff(8), 256)
        XCTAssertEqual(SyncEngine.backoff(9), 300)
        XCTAssertEqual(SyncEngine.backoff(40), 300)
    }

    func testNoteTitles() {
        XCTAssertEqual(OutboxStore.noteTitle("## Shopping\n- eggs"), "Shopping")
        XCTAssertEqual(OutboxStore.noteTitle("\n\n"), "Note")
    }

    func testPairingAsksAsAPhoneAndReturnsTheTokenOnce() async throws {
        let device = UUID()
        server.respond = { call in
            call.path.hasSuffix("/start")
                ? (200, #"{"code":"ABCD2345","verificationUrl":"https://eavesy.test/connect/mac?code=ABCD2345","expiresInSec":600}"#)
                : (200, #"{"status":"paired","token":"eavesy_device_new"}"#)
        }
        let api = EavesyAPI(base: URL(string: "https://eavesy.test")!, transport: server) { nil }

        let start = try await api.startPairing(deviceId: device, name: "Eavesy for iPhone")
        let token = try await api.pairingToken(code: start.code, deviceId: device)

        XCTAssertEqual(token, "eavesy_device_new")
        let body = try JSONSerialization.jsonObject(with: server.calls[0].body) as? [String: String]
        XCTAssertEqual(body?["platform"], "ios")
        XCTAssertNil(server.calls[0].headers["authorization"])
    }
}
