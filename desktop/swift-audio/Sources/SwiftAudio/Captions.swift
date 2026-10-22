import AVFoundation
import Foundation

/// One caption update for a track. A partial replaces the track's previous
/// partial; a final is settled text for `startMs..<endMs` of the recording.
/// A `preview` partial holds words only the fast transcriber has heard: the
/// host shows it but never pastes or stores it.
struct CaptionEvent: Equatable {
    let track: String
    let text: String
    let isFinal: Bool
    let startMs: Int64
    let endMs: Int64
    var preview = false

    var json: [String: Any] {
        var json: [String: Any] = [
            "event": "caption",
            "track": track,
            "text": text,
            "final": isFinal,
            "startMs": startMs,
            "endMs": endMs,
        ]
        if preview { json["preview"] = true }
        return json
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

/// How a track's captions ended, sent once when the recording stops. The host
/// trusts the text only when nothing was dropped and the engine finished in time.
struct CaptionSummary: Equatable {
    let dropped: Int
    let timedOut: Bool
    let failed: Bool

    func json(track: String) -> [String: Any] {
        ["event": "captions_done", "track": track, "dropped": dropped, "timedOut": timedOut, "failed": failed]
    }
}

/// How a `LiveCaptions.switchEngine` request ended.
enum EngineSwitch: Equatable {
    case switched
    /// A later switch was asked for before this one's engine was ready.
    case superseded
    case unavailable(String)
}

struct CaptionUnavailable: Error {
    let reason: String
}

/// Receives what a speech engine recognizes. Times are ms from the start of the
/// recording, the same clock segment offsets use.
protocol CaptionSink: AnyObject {
    /// `preview` text is shown, never pasted or stored; it is never final.
    func recognized(text: String, isFinal: Bool, startMs: Int64, endMs: Int64, preview: Bool)
    func engineFailed(_ reason: String)
    /// Audio the engine let go of before recognizing it, so its text is missing words.
    func audioDropped(_ count: Int)
}

extension CaptionSink {
    func recognized(text: String, isFinal: Bool, startMs: Int64, endMs: Int64) {
        recognized(text: text, isFinal: isFinal, startMs: startMs, endMs: endMs, preview: false)
    }
}

/// An on-device recognizer fed 48 kHz mono float audio.
protocol SpeechEngine: AnyObject {
    var name: String { get }
    func start(sink: CaptionSink) throws
    func append(_ buffer: AVAudioPCMBuffer, atMs: Int64) throws
    /// Ends input and reports any last finals, then calls `done`. Also called,
    /// to let it go, on an engine that never started; it must still call `done`.
    func finish(_ done: @escaping () -> Void)
}

/// Live captions for one track, running beside the recording and never in its
/// way: feeding is a copy and a hop to a private queue, every engine call is
/// caught, and a failure turns captions off for the rest of the recording.
/// Memory is bounded twice: buffers queued for the engine are capped at
/// `maxBacklog`, and audio held while the engine is not ready yet (say, while
/// the permission prompt is up) at `maxWaitingFrames`, oldest dropped first.
/// Every dropped buffer is counted and reported in `captions_done`.
/// `switchEngine` swaps in another engine mid-recording (another language):
/// the old one keeps its audio and settles its last finals, the new one takes
/// every buffer from then on, so no audio is lost or captioned twice.
final class LiveCaptions: CaptionSink {
    /// Buffers queued for the engine; past this it is not keeping up.
    static let maxBacklog = 500
    /// About ten seconds of 48 kHz audio held before the engine is ready.
    static let maxWaitingFrames = 480_000

    let track: String
    private let queue: DispatchQueue
    private let emit: ([String: Any]) -> Void
    private let lock = NSLock()
    private var engine: SpeechEngine?
    private var waiting: [(AVAudioPCMBuffer, Int64)] = []
    private var waitingFrames = 0
    private var dropped = 0
    private var failed = false
    private var finishing = false
    private var backlog = 0
    private let onFinal: ((String, Int64) -> Void)?
    /// The sink each engine reports to; a replaced engine's can no longer turn captions off.
    private var sinks: [EngineSink] = []
    /// Replaced engines still settling their last finals.
    private let draining = DispatchGroup()
    /// The latest `switchEngine` request; an earlier one that answers late loses.
    private var switches = 0
    /// Switches asked for whose engine has not answered yet.
    private var pendingSwitches = 0
    /// Why the first engine could not run, while a switch might still.
    private var firstFailure: String?

    /// `makeEngine` may answer later (authorization and model checks are async);
    /// audio fed meanwhile is held, up to `maxWaitingFrames`.
    init(
        track: String,
        emit: @escaping ([String: Any]) -> Void,
        onFinal: ((String, Int64) -> Void)? = nil,
        makeEngine: (@escaping (Result<SpeechEngine, CaptionUnavailable>) -> Void) -> Void
    ) {
        self.track = track
        self.emit = emit
        self.onFinal = onFinal
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
            dropped += 1
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
                self.hold(buffer, atMs: atMs)
            }
        }
    }

    /// Waits up to `timeout` for the engine's last finals, then reports how
    /// captions ended (`captions_done`). Call once, from any thread except this
    /// track's queue.
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
            self.dropWaiting()
            let draining = self.draining
            guard let engine = self.engine, !self.failed else {
                draining.notify(queue: .global()) { done.signal() }
                return
            }
            engine.finish { draining.notify(queue: .global()) { done.signal() } }
        }
        let timedOut = done.wait(timeout: .now() + timeout) == .timedOut
        lock.lock()
        let summary = CaptionSummary(dropped: dropped, timedOut: timedOut, failed: failed)
        lock.unlock()
        emit(summary.json(track: track))
    }

    /// Moves captions to the engine `makeEngine` answers with, once it has
    /// started. Before the first engine is ready, the new one takes its place.
    /// `outcome` says whether captions moved, a later switch overtook this
    /// one, or nothing changed and why.
    func switchEngine(
        _ makeEngine: (@escaping (Result<SpeechEngine, CaptionUnavailable>) -> Void) -> Void,
        outcome: @escaping (EngineSwitch) -> Void
    ) {
        lock.lock()
        switches += 1
        pendingSwitches += 1
        let request = switches
        lock.unlock()
        makeEngine { [weak self] result in
            guard let self else { return }
            self.queue.async { self.replaceEngine(result, request: request, outcome: outcome) }
        }
    }

    /// Called on `queue`.
    private func replaceEngine(
        _ result: Result<SpeechEngine, CaptionUnavailable>, request: Int, outcome: (EngineSwitch) -> Void
    ) {
        lock.lock()
        pendingSwitches -= 1
        lock.unlock()
        defer { giveUpIfNothingLeft() }
        let next: SpeechEngine
        switch result {
        case .failure(let reason):
            outcome(.unavailable(reason.reason))
            return
        case .success(let engine):
            next = engine
        }
        lock.lock()
        let latest = request == switches
        lock.unlock()
        guard latest else {
            next.finish {}
            outcome(.superseded)
            return
        }
        guard !isOff else {
            next.finish {}
            outcome(.unavailable("captions are off"))
            return
        }
        guard let old = engine else {
            if let failure = install(next) {
                outcome(.unavailable(failure))
            } else {
                outcome(.switched)
            }
            return
        }
        let sink = EngineSink(self)
        do {
            try next.start(sink: sink)
        } catch {
            outcome(.unavailable("speech engine did not start: \(error.localizedDescription)"))
            return
        }
        sinks.last?.retire()
        sinks.append(sink)
        engine = next
        draining.enter()
        let draining = self.draining
        old.finish { draining.leave() }
        emit(CaptionStatus.live(engine: next.name).json(track: track))
        outcome(.switched)
    }

    /// Called on `queue`.
    private func hold(_ buffer: AVAudioPCMBuffer, atMs: Int64) {
        waiting.append((buffer, atMs))
        waitingFrames += Int(buffer.frameLength)
        var shed = 0
        while waitingFrames > Self.maxWaitingFrames, !waiting.isEmpty {
            waitingFrames -= Int(waiting.removeFirst().0.frameLength)
            shed += 1
        }
        if shed > 0 { countDropped(shed) }
    }

    /// Called on `queue`: audio held for an engine that will never take it.
    private func dropWaiting() {
        if !waiting.isEmpty { countDropped(waiting.count) }
        waiting.removeAll()
        waitingFrames = 0
    }

    /// The first loss is said at once (`captions_dropped`): a dictation that
    /// pastes before `captions_done` must still know its text has gaps.
    private func countDropped(_ count: Int) {
        guard count > 0 else { return }
        lock.lock()
        let first = dropped == 0
        dropped += count
        lock.unlock()
        if first { emit(["event": "captions_dropped", "track": track, "dropped": count]) }
    }

    private func engineReady(_ result: Result<SpeechEngine, CaptionUnavailable>) {
        switch result {
        case .failure(let unavailable):
            // A switch that answered first already has captions running, and
            // one still to answer may yet.
            guard engine == nil else { return }
            firstFailure = unavailable.reason
            giveUpIfNothingLeft()
        case .success(let engine):
            guard self.engine == nil else {
                engine.finish {}
                return
            }
            guard !isOff else { return }
            if let failure = install(engine) {
                firstFailure = failure
                giveUpIfNothingLeft()
            }
        }
    }

    /// Called on `queue`: the first engine failed and no switch is left to
    /// take its place, so captions are off.
    private func giveUpIfNothingLeft() {
        guard engine == nil, let reason = firstFailure else { return }
        lock.lock()
        let pending = pendingSwitches
        lock.unlock()
        guard pending == 0 else { return }
        firstFailure = nil
        turnOff(reason)
    }

    /// Called on `queue`: the first engine to run, fed the audio held for it.
    /// Nil once it runs, else why it did not start.
    private func install(_ engine: SpeechEngine) -> String? {
        let sink = EngineSink(self)
        do {
            try engine.start(sink: sink)
        } catch {
            return "speech engine did not start: \(error.localizedDescription)"
        }
        sinks.append(sink)
        self.engine = engine
        emit(CaptionStatus.live(engine: engine.name).json(track: track))
        let held = waiting
        waiting.removeAll()
        waitingFrames = 0
        for (buffer, atMs) in held {
            guarded { try engine.append(buffer, atMs: atMs) }
        }
        return nil
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
        waitingFrames = 0
        if first { emit(CaptionStatus.unavailable(reason: reason).json(track: track)) }
    }

    // MARK: CaptionSink (called from engine callbacks on any thread)

    func recognized(text: String, isFinal: Bool, startMs: Int64, endMs: Int64, preview: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !isFinal else { return }
        // Only the accurate transcriber settles text.
        guard !(preview && isFinal) else { return }
        lock.lock()
        let off = failed
        lock.unlock()
        guard !off else { return }
        emit(
            CaptionEvent(
                track: track, text: trimmed, isFinal: isFinal, startMs: startMs, endMs: endMs, preview: preview
            ).json)
        if isFinal { onFinal?(trimmed, endMs) }
    }

    func engineFailed(_ reason: String) {
        queue.async { [weak self] in self?.turnOff(reason) }
    }

    func audioDropped(_ count: Int) {
        countDropped(count)
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

/// Stands between one engine and its captions. Engines hold their sink weakly,
/// so `LiveCaptions` keeps these. Once its engine is replaced, a failure while
/// it settles is not a reason to turn captions off; its last finals still count.
private final class EngineSink: CaptionSink {
    private weak var captions: LiveCaptions?
    private let lock = NSLock()
    private var retired = false

    init(_ captions: LiveCaptions) {
        self.captions = captions
    }

    func retire() {
        lock.lock()
        retired = true
        lock.unlock()
    }

    func recognized(text: String, isFinal: Bool, startMs: Int64, endMs: Int64, preview: Bool) {
        captions?.recognized(text: text, isFinal: isFinal, startMs: startMs, endMs: endMs, preview: preview)
    }

    func audioDropped(_ count: Int) {
        captions?.audioDropped(count)
    }

    func engineFailed(_ reason: String) {
        lock.lock()
        let replaced = retired
        lock.unlock()
        if replaced {
            FileHandle.standardError.write(Data("replaced caption engine: \(reason)\n".utf8))
        } else {
            captions?.engineFailed(reason)
        }
    }
}
