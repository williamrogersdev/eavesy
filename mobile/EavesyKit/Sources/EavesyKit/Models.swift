import Foundation

public struct PairingStart: Decodable, Sendable {
    public let code: String
    public let verificationUrl: URL
    public let expiresInSec: Int
}

public struct Account: Codable, Sendable, Equatable {
    public let email: String?
    public let name: String?
}

/// A note or image in the account, from any device.
public struct RemoteCapture: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let kind: String
    public let clientCaptureId: String?
    public let title: String
    public let contentType: String
    public let bytes: Int
    /// Text found in an image. Always nil for a note: its text is its content.
    public let transcript: String?
    public let createdAt: Double
    public let deviceName: String?
}

/// A finished recording in the account, from any device.
public struct RemoteSession: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let title: String?
    public let startedAt: Double
    public let durationSec: Double?
    public let source: String?
    public let deviceName: String?
    public let thisDevice: Bool?
}

public struct SessionResult: Decodable, Sendable {
    public struct Line: Decodable, Sendable {
        public let startMs: Int
        public let text: String
        public let speaker: String?
    }

    public struct Summary: Decodable, Sendable {
        public let tldr: String?
        public let decisionsJson: String?
        public let actionItemsJson: String?
    }

    public let meetingId: String
    /// recording | queued | uploading | processing | complete | failed
    public let status: String
    public let title: String?
    public let transcriptReady: Bool
    public let transcript: [Line]
    public let summary: Summary?

    public var isFinal: Bool { status == "complete" || status == "failed" }
}
