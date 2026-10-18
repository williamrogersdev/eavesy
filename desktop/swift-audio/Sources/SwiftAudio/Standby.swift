import AVFoundation
import CoreMedia
import Foundation

/// Lines from a byte stream, split on newlines and trimmed. One reader serves
/// stdin for the whole process, so bytes read past a standby's `start` line
/// (a quick `stop`) are kept for whoever reads next.
final class LineReader {
    private let read: () -> Data
    private var buffer = Data()

    /// `read` returns the next chunk, or empty data at end of input.
    init(read: @escaping () -> Data) {
        self.read = read
    }

    convenience init(handle: FileHandle) {
        self.init { handle.availableData }
    }

    /// The next line, or nil once the input has ended.
    func next() -> String? {
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                return String(decoding: line, as: UTF8.self)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            let chunk = read()
            if chunk.isEmpty { return nil }
            buffer.append(chunk)
        }
    }
}

/// A capture engine launched before the hotkey, so the press does not wait for
/// the process and its frameworks to load. It prepares what it can without
/// touching the microphone, then waits for `{"start":[...]}`: the arguments a
/// cold launch would have had.
enum Standby {
    static func startArguments(_ line: String) -> [String]? {
        guard
            let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let argv = object["start"] as? [String]
        else { return nil }
        return argv
    }

    /// Blocks until the host says start. Nil when the host went away first.
    static func awaitStart(_ lines: LineReader) -> [String]? {
        while let line = lines.next() {
            if let argv = startArguments(line) { return argv }
            if line == "stop" { return nil }
        }
        return nil
    }
}

/// The moment this capture was asked for: process launch for a cold start, the
/// `start` line for a standby. On the host clock, which also stamps microphone
/// buffers, so a buffer's audio can be placed against it.
enum StartClock {
    private(set) static var startedAt = CMClockGetTime(CMClockGetHostTimeClock())

    static func mark() {
        startedAt = CMClockGetTime(CMClockGetHostTimeClock())
    }

    /// Milliseconds from the start to `time` (now by default).
    static func ms(to time: CMTime = CMClockGetTime(CMClockGetHostTimeClock())) -> Int64 {
        Int64((CMTimeGetSeconds(CMTimeSubtract(time, startedAt)) * 1000).rounded())
    }
}

/// A microphone capture session built in standby: device looked up, input and
/// output added, but never started. Nothing flows from the microphone and the
/// menu bar shows no recording indicator until `startRunning`.
final class MicWarmup {
    let session: AVCaptureSession
    let output: AVCaptureAudioDataOutput
    let deviceID: String

    private init(session: AVCaptureSession, output: AVCaptureAudioDataOutput, deviceID: String) {
        self.session = session
        self.output = output
        self.deviceID = deviceID
    }

    /// Only with access already granted: a standby never asks, the capture it
    /// becomes asks as a cold one would.
    static func prepare() -> MicWarmup? {
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
            let device = AVCaptureDevice.default(for: .audio),
            let input = try? AVCaptureDeviceInput(device: device)
        else { return nil }
        let session = AVCaptureSession()
        session.beginConfiguration()
        let output = AVCaptureAudioDataOutput()
        guard session.canAddInput(input), session.canAddOutput(output) else {
            session.commitConfiguration()
            return nil
        }
        session.addInput(input)
        session.addOutput(output)
        session.commitConfiguration()
        return MicWarmup(session: session, output: output, deviceID: device.uniqueID)
    }

    /// Whether this session still records the default microphone: one plugged
    /// in since standby began gets a fresh session instead.
    func matches(_ device: AVCaptureDevice) -> Bool {
        device.uniqueID == deviceID
    }
}
