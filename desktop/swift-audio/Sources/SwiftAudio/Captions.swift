import AVFoundation
import Foundation

/// One caption update for a track. A partial replaces the track's previous
/// partial; a final is settled text for `startMs..<endMs` of the recording.
struct CaptionEvent: Equatable {
    let track: String
    let text: String
    let isFinal: Bool
    let startMs: Int64
    let endMs: Int64

    var json: [String: Any] {
        [
            "event": "caption",
            "track": track,
            "text": text,
            "final": isFinal,
            "startMs": startMs,
            "endMs": endMs,
        ]
    }
}

/// Where live captions stand for a track, so the host can say why there are none.
enum CaptionStatus: Equatable {
    case live(engine: String)
    case unavailable(reason: String)

    func json(track: String) -> [String: Any] {
        switch self {
        case .live(let engine):
            return ["event": "captions_status", "track": track, "status": "live", "engine": engine]
        case .unavailable(let reason):
            return ["event": "captions_status", "track": track, "status": "unavailable", "reason": reason]
        }
    }
}

struct CaptionUnavailable: Error {
    let reason: String
}

/// Receives what a speech engine recognizes. Times are ms from the start of the
/// recording, the same clock segment offsets use.
protocol CaptionSink: AnyObject {
    func recognized(text: String, isFinal: Bool, startMs: Int64, endMs: Int64)
    func engineFailed(_ reason: String)
}

/// An on-device recognizer fed 48 kHz mono float audio.
protocol SpeechEngine: AnyObject {
    var name: String { get }
    func start(sink: CaptionSink) throws
    func append(_ buffer: AVAudioPCMBuffer, atMs: Int64) throws
    /// Ends input and reports any last finals, then calls `done`.
    func finish(_ done: @escaping () -> Void)
}

/// Live captions for one track, running beside the recording and never in its
/// way: feeding is a copy and a hop to a private queue, every engine call is
/// caught, a failure turns captions off for the rest of the recording, and a
/// backlog is dropped rather than buffered without bound.
final class LiveCaptions: CaptionSink {
    /// About ten seconds of capture buffers; past that the engine is not keeping up.
    static let maxBacklog = 500

    let track: String
    private let queue: DispatchQueue
    private let emit: ([String: Any]) -> Void
    private let lock = NSLock()
    private var engine: SpeechEngine?
    private var waiting: [(AVAudioPCMBuffer, Int64)] = []
    private var failed = false
    private var finishing = false
    private var backlog = 0

    /// `makeEngine` may answer later (authorization and model checks are async);
    /// audio fed meanwhile is held, up to the backlog limit.
    init(
        track: String,
        emit: @escaping ([String: Any]) -> Void,
        makeEngine: (@escaping (Result<SpeechEngine, CaptionUnavailable>) -> Void) -> Void
    ) {
        self.track = track
        self.emit = emit
        self.queue = DispatchQueue(label: "com.eavesy.swiftaudio.captions.\(track)")
        makeEngine { [weak self] result in
            self?.queue.async { self?.engineReady(result) }
        }
    }

    private var isOff: Bool {
        lock.lock()
        defer { lock.unlock() }
        return failed || finishing
    }

    func feed(_ samples: [Float], atMs: Int64) {
        guard !samples.isEmpty, !isOff else { return }
        lock.lock()
        if backlog >= Self.maxBacklog {
            lock.unlock()
            return
        }
        backlog += 1
        lock.unlock()
        guard let buffer = Self.pcmBuffer(samples) else {
            release()
            return
        }
        queue.async { [weak self] in
            guard let self else { return }
            self.release()
            if let engine = self.engine {
                self.guarded { try engine.append(buffer, atMs: atMs) }
            } else if !self.isOff {
                self.waiting.append((buffer, atMs))
            }
        }
    }

    /// Waits up to `timeout` for the engine's last finals. Safe to call once
    /// from any thread except this track's queue.
    func finish(timeout: TimeInterval) {
        let done = DispatchSemaphore(value: 0)
        queue.async { [weak self] in
            guard let self else {
                done.signal()
                return
            }
            self.lock.lock()
            self.finishing = true
            self.lock.unlock()
            self.waiting.removeAll()
            guard let engine = self.engine, !self.failed else {
                done.signal()
                return
            }
            engine.finish { done.signal() }
        }
        _ = done.wait(timeout: .now() + timeout)
    }

    private func engineReady(_ result: Result<SpeechEngine, CaptionUnavailable>) {
        switch result {
        case .failure(let unavailable):
            turnOff(unavailable.reason)
        case .success(let engine):
            guard !isOff else { return }
            do {
                try engine.start(sink: self)
            } catch {
                turnOff("speech engine did not start: \(error.localizedDescription)")
                return
            }
            self.engine = engine
            emit(CaptionStatus.live(engine: engine.name).json(track: track))
            let held = waiting
            waiting.removeAll()
            for (buffer, atMs) in held {
                guarded { try engine.append(buffer, atMs: atMs) }
            }
        }
    }

    private func guarded(_ work: () throws -> Void) {
        do {
            try work()
        } catch {
            turnOff("speech engine failed: \(error.localizedDescription)")
        }
    }

    private func release() {
        lock.lock()
        backlog -= 1
        lock.unlock()
    }

    private func turnOff(_ reason: String) {
        lock.lock()
        let first = !failed
        failed = true
        lock.unlock()
        engine = nil
        waiting.removeAll()
        if first { emit(CaptionStatus.unavailable(reason: reason).json(track: track)) }
    }

    // MARK: CaptionSink (called from engine callbacks on any thread)

    func recognized(text: String, isFinal: Bool, startMs: Int64, endMs: Int64) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !isFinal else { return }
        lock.lock()
        let off = failed
        lock.unlock()
        guard !off else { return }
        emit(CaptionEvent(track: track, text: trimmed, isFinal: isFinal, startMs: startMs, endMs: endMs).json)
    }

    func engineFailed(_ reason: String) {
        queue.async { [weak self] in self?.turnOff(reason) }
    }

    static func pcmBuffer(_ samples: [Float]) -> AVAudioPCMBuffer? {
        guard
            let buffer = AVAudioPCMBuffer(
                pcmFormat: AudioRecorder.mixFormat, frameCapacity: AVAudioFrameCount(samples.count)),
            let channel = buffer.floatChannelData
        else { return nil }
        samples.withUnsafeBufferPointer { source in
            channel[0].update(from: source.baseAddress!, count: samples.count)
        }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        return buffer
    }
}
