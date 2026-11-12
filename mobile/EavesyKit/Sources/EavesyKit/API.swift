import Foundation

/// What a request sends as its body.
public enum HTTPBody: Sendable {
    case none
    case data(Data)
    case file(URL)
}

/// The network, behind a seam so tests can stand in for the server.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest, body: HTTPBody) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest, body: HTTPBody) async throws -> (Data, HTTPURLResponse) {
        let (data, response): (Data, URLResponse)
        switch body {
        case .none: (data, response) = try await session.data(for: request)
        case .data(let bytes): (data, response) = try await session.upload(for: request, from: bytes)
        case .file(let url): (data, response) = try await session.upload(for: request, fromFile: url)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.network("no HTTP response") }
        return (data, http)
    }
}

public enum APIError: Error, Equatable, Sendable {
    /// The device token is missing, revoked or unknown: sign in again.
    case unauthorized
    /// The server answered with this status; `message` is its `error` field.
    case http(status: Int, message: String)
    case network(String)
    case decoding(String)

    /// A retry cannot fix it: any 4xx except the ones that mean "later".
    public var isPermanent: Bool {
        guard case .http(let status, _) = self else { return false }
        return (400..<500).contains(status) && ![408, 425, 429].contains(status)
    }
}

/// The Eavesy web API as a paired device sees it: the same routes the Mac app
/// uses (`docs/ARCHITECTURE.md`), authenticated with a device token.
public struct EavesyAPI: Sendable {
    public let base: URL
    private let token: @Sendable () -> String?
    private let transport: HTTPTransport

    public init(base: URL, transport: HTTPTransport = URLSessionTransport(), token: @escaping @Sendable () -> String?) {
        self.base = base
        self.transport = transport
        self.token = token
    }

    // MARK: Sign-in (browser-approved pairing)

    public func startPairing(deviceId: UUID, name: String) async throws -> PairingStart {
        let body = ["deviceId": deviceId.uuidString.lowercased(), "name": name, "platform": "ios"]
        return try await json("POST", "/api/devices/pair/start", json: body, authed: false)
    }

    /// `nil` while the user hasn't approved yet. The token comes back exactly once.
    public func pairingToken(code: String, deviceId: UUID) async throws -> String? {
        let body = ["code": code, "deviceId": deviceId.uuidString.lowercased()]
        let status: PairingStatus = try await json("POST", "/api/devices/pair/status", json: body, authed: false)
        return status.status == "paired" ? status.token : nil
    }

    public func account() async throws -> Account {
        try await json("GET", "/api/devices/me")
    }

    /// Revokes this device's token on the server.
    public func signOut() async throws {
        _ = try await raw("DELETE", "/api/devices/me")
    }

    // MARK: Notes and images

    /// Stores a note (`text/markdown`) or an image. Safe to repeat: the server
    /// keeps one capture per `clientId`.
    public func uploadCapture(clientId: UUID, file: URL, contentType: String, title: String, capturedAt: Date) async throws -> String {
        let headers = [
            "content-type": contentType,
            "x-client-capture-id": clientId.uuidString.lowercased(),
            "x-title": title.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "",
            "x-captured-at": String(Int(capturedAt.timeIntervalSince1970 * 1000)),
        ]
        let (data, _) = try await raw("POST", "/api/devices/captures", headers: headers, body: .file(file))
        return try decode(Created.self, data).id
    }

    public func captures(limit: Int = 100) async throws -> [RemoteCapture] {
        let list: Items<RemoteCapture> = try await json("GET", "/api/devices/captures?all=1&limit=\(limit)")
        return list.items
    }

    public func captureContent(id: String) async throws -> Data {
        let path = "/api/devices/captures/" + (id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "_-"))) ?? id)
        return try await raw("GET", path).0
    }

    // MARK: Recordings

    /// Creates the cloud recording for `clientSessionId`, or finds the one already made for it.
    public func createSession(clientSessionId: UUID, title: String?, startedAt: Date) async throws -> String {
        var body: [String: Any] = [
            "clientSessionId": clientSessionId.uuidString.lowercased(),
            "startedAt": Int(startedAt.timeIntervalSince1970 * 1000),
        ]
        if let title, !title.isEmpty { body["title"] = title }
        let created: SessionCreated = try await json("POST", "/api/sessions", json: body)
        return created.meetingId
    }

    public func uploadSegment(meetingId: String, index: Int, file: URL, startMs: Int, durationMs: Int) async throws {
        let headers = [
            "content-type": "audio/mp4",
            "x-segment-start-ms": String(startMs),
            "x-segment-duration-ms": String(durationMs),
            "x-segment-track": "mic",
        ]
        _ = try await raw("PUT", "/api/sessions/\(meetingId)/segments/\(index)", headers: headers, body: .file(file))
    }

    /// Ends a recording whose audio went up as segments.
    public func finalize(meetingId: String) async throws {
        _ = try await raw("POST", "/api/sessions/\(meetingId)/finalize?archive=none")
    }

    public func cancelSession(meetingId: String) async throws {
        _ = try await raw("DELETE", "/api/sessions/\(meetingId)")
    }

    public func result(meetingId: String) async throws -> SessionResult {
        try await json("GET", "/api/sessions/\(meetingId)/result")
    }

    public func sessions(limit: Int = 100) async throws -> [RemoteSession] {
        let list: Items<RemoteSession> = try await json("GET", "/api/sessions?all=1&limit=\(limit)")
        return list.items
    }

    // MARK: Live

    /// A one-time ticket and the socket URL that says when another device saved something.
    public func liveSocketURL() async throws -> URL {
        let ticket: LiveTicket = try await json("POST", "/api/devices/live")
        var parts = URLComponents(url: base.appendingPathComponent("api/drops/live"), resolvingAgainstBaseURL: false)!
        parts.scheme = base.scheme == "http" ? "ws" : "wss"
        parts.queryItems = [.init(name: "u", value: ticket.userId), .init(name: "ticket", value: ticket.ticket)]
        return parts.url!
    }

    // MARK: Plumbing

    private func json<T: Decodable>(_ method: String, _ path: String, json body: [String: Any]? = nil, authed: Bool = true) async throws -> T {
        var headers: [String: String] = [:]
        var payload = HTTPBody.none
        if let body {
            headers["content-type"] = "application/json"
            payload = .data(try JSONSerialization.data(withJSONObject: body))
        }
        let (data, _) = try await raw(method, path, headers: headers, body: payload, authed: authed)
        return try decode(T.self, data)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    @discardableResult
    private func raw(_ method: String, _ path: String, headers: [String: String] = [:], body: HTTPBody = .none, authed: Bool = true) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: base) else { throw APIError.network("bad path \(path)") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 120
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if authed {
            guard let token = token() else { throw APIError.unauthorized }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request, body: body)
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        if response.statusCode == 401 && authed { throw APIError.unauthorized }
        guard (200..<300).contains(response.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? ""
            throw APIError.http(status: response.statusCode, message: message)
        }
        return (data, response)
    }
}

private struct ErrorBody: Decodable { let error: String? }
private struct Created: Decodable { let id: String }
private struct SessionCreated: Decodable { let meetingId: String }
private struct PairingStatus: Decodable { let status: String; let token: String? }
private struct LiveTicket: Decodable { let userId: String; let ticket: String }
private struct Items<T: Decodable>: Decodable { let items: [T] }
