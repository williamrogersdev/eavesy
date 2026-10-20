// Compile with the production Captions.swift and CaptionEngines.swift.
// Feeds a 48 kHz mono fixture at recording speed, without opening a microphone,
// playing sound, changing focus, or touching the user's clipboard.
import AVFoundation
import Foundation
import Speech

// The capture engine's input format; the microphone recorder is not needed here.
enum AudioRecorder {
    static let mixFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
}
enum EventEmitter {
    static func warning(_ message: String) { FileHandle.standardError.write(Data((message + "\n").utf8)) }
}
final class FixtureSink: CaptionSink {
    private let lock = NSLock()
    private let output: FileHandle
    init(path: String) throws {
        FileManager.default.createFile(atPath: path, contents: nil)
        output = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
    }
    func recognized(text: String, isFinal: Bool, startMs: Int64, endMs: Int64) {
        let event = CaptionEvent(track: "mic", text: text, isFinal: isFinal, startMs: startMs, endMs: endMs)
        lock.lock(); defer { lock.unlock() }
        if let data = try? JSONSerialization.data(withJSONObject: event.json) {
            output.write(data); output.write(Data([10]))
        }
    }
    func engineFailed(_ reason: String) { EventEmitter.warning("engine failed: \(reason)") }
    func audioDropped(_ count: Int) { EventEmitter.warning("dropped audio: \(count)") }
}
@main struct CaptionFixture {
    static func main() async throws {
        let args = CommandLine.arguments
        guard args.count == 4 else { fatalError("Usage: caption-fixture analyzer|legacy input.wav output.jsonl") }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            EventEmitter.warning("Speech permission unavailable; no prompt was requested")
            exit(78)
        }
        let result: Result<SpeechEngine, CaptionUnavailable>
        if args[1] == "legacy" {
            result = SFSpeechEngine.make(locale: Locale(identifier: "en_US"))
        } else {
            if #available(macOS 26.0, *) {
                result = await AnalyzerEngine.make(locale: Locale(identifier: "en_US"), vocabulary: [])
            } else { fatalError("SpeechAnalyzer requires macOS 26") }
        }
        let engine = try result.get()
        let sink = try FixtureSink(path: args[3])
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: args[2]))
        guard file.processingFormat.sampleRate == 48_000, file.processingFormat.channelCount == 1 else {
            fatalError("Fixture must be 48 kHz mono")
        }
        let limit = UInt64(Double(file.length) / 48_000 + 30) * 1_000_000_000
        Task.detached {
            try? await Task.sleep(nanoseconds: limit)
            EventEmitter.warning("Speech fixture timed out")
            exit(124)
        }
        try engine.start(sink: sink)
        while file.framePosition < file.length {
            let start = file.framePosition
            let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 960)!
            try file.read(into: buffer, frameCount: 960)
            try engine.append(buffer, atMs: Int64(Double(start) / 48.0))
            try await Task.sleep(nanoseconds: UInt64(Double(buffer.frameLength) / 48_000 * 1_000_000_000))
        }
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            engine.finish { done.resume() }
        }
        print("\(engine.name): completed \(Double(file.length) / 48_000) seconds")
    }
}
