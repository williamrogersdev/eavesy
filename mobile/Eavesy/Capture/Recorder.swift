import AVFoundation
import EavesyKit

/// Records the microphone into roughly one-minute AAC segments, each written
/// to the outbox the moment it is sealed. A segment closes at the first quiet
/// moment after a minute, or at 90 seconds: the Mac app's rule.
final class Recorder: @unchecked Sendable {
    enum Failure: LocalizedError {
        case micDenied
        case noInput

        var errorDescription: String? {
            switch self {
            case .micDenied: "Couldn't start recording: microphone access is off."
            case .noInput: "Couldn't start recording: no microphone is available."
            }
        }
    }

    static let targetSec = 60.0
    static let maxSec = 90.0
    private static let quietRms: Float = 0.012

    let id: UUID
    let startedAt = Date()
    /// Mic level 0...1, about ten times a second, on the main actor.
    var onLevel: (@MainActor (Double) -> Void)?
    /// A segment reached disk.
    var onSegment: (@MainActor () -> Void)?
    /// The system took the microphone away (a phone call, say).
    var onInterrupted: (@MainActor () -> Void)?
    /// Audio could not be written to disk (no space, say). Sent once.
    var onWriteFailed: (@MainActor () -> Void)?

    private let store: OutboxStore
    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "com.eavesy.mobile.recorder")
    private var file: AVAudioFile?
    private var fileName = ""
    private var sampleRate = 48_000.0
    private var index = 0
    private var framesBefore: Int64 = 0
    private var framesInSegment: Int64 = 0
    private var lastLevelAt = Date.distantPast
    private var stopped = false
    private var writeFailed = false
    private var interruption: NSObjectProtocol?

    init(store: OutboxStore) throws {
        self.store = store
        var item = OutboxItem(kind: .recording, title: "Voice note", state: .recording)
        item.createdAt = startedAt
        id = item.id
        try store.save(item)
    }

    static func micAllowed() async -> Bool {
        await withCheckedContinuation { done in
            AVAudioApplication.requestRecordPermission { done.resume(returning: $0) }
        }
    }

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default, options: [.allowBluetoothHFP])
        try session.setActive(true)

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw Failure.noInput }
        sampleRate = format.sampleRate
        input.installTap(onBus: 0, bufferSize: 4_096, format: format) { [weak self] buffer, _ in
            // The engine reuses its buffer once this block returns, so the samples are
            // copied here and the copy is what the recorder queue writes.
            guard let self, let samples = Self.firstChannel(of: buffer) else { return }
            self.queue.async { self.write(samples) }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            // Leave nothing behind for the next attempt to trip over.
            input.removeTap(onBus: 0)
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw error
        }

        interruption = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            Task { @MainActor in self?.onInterrupted?() }
        }
    }

    /// Seals the last segment and hands the recording to the sync engine.
    /// Returns false when no audio reached disk: the item is removed rather
    /// than kept as a recording with a length and nothing in it.
    @discardableResult
    func stop() -> Bool {
        if let interruption { NotificationCenter.default.removeObserver(interruption) }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        let kept = queue.sync { () -> Bool in
            guard !stopped else { return store.item(id) != nil }
            stopped = true
            seal()
            guard let item = store.item(id), !item.segments.isEmpty else {
                store.remove(id)
                return false
            }
            let totalMs = Int(Double(framesBefore) / sampleRate * 1_000)
            _ = try? store.update(id) {
                $0.state = .pending
                $0.durationMs = totalMs
            }
            return true
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return kept
    }

    // MARK: On the recorder queue

    /// The voice is the first channel; a stereo input repeats it.
    private static func firstChannel(of buffer: AVAudioPCMBuffer) -> [Float]? {
        guard buffer.frameLength > 0, let source = buffer.floatChannelData else { return nil }
        return Array(UnsafeBufferPointer(start: source[0], count: Int(buffer.frameLength)))
    }

    private func write(_ samples: [Float]) {
        guard !stopped else { return }
        let frames = AVAudioFrameCount(samples.count)
        do {
            if file == nil { try open() }
            guard let file, let mono = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames),
                  let target = mono.floatChannelData else { return }
            mono.frameLength = frames
            samples.withUnsafeBufferPointer { target[0].update(from: $0.baseAddress!, count: samples.count) }
            try file.write(from: mono)
            framesInSegment += Int64(frames)

            let level = Self.rms(samples)
            report(level)
            let seconds = Double(framesInSegment) / sampleRate
            if seconds >= Self.maxSec || (seconds >= Self.targetSec && level < Self.quietRms) { seal() }
        } catch {
            // A segment that can't be written is dropped: its half-written file is
            // removed, and the time it covered stays a gap so later segments keep
            // their place. The ones already sealed stay.
            file = nil
            try? FileManager.default.removeItem(at: store.folder(for: id).appendingPathComponent(fileName))
            framesBefore += framesInSegment + Int64(frames)
            framesInSegment = 0
            index += 1
            // Tell the app once, so it can stop and say so rather than record on into nothing.
            if !writeFailed {
                writeFailed = true
                Task { @MainActor [onWriteFailed] in onWriteFailed?() }
            }
        }
    }

    private func open() throws {
        fileName = String(format: "segment-%06d.m4a", index)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000,
        ]
        let url = store.folder(for: id).appendingPathComponent(fileName)
        file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    }

    private func seal() {
        guard file != nil, framesInSegment > 0 else { return }
        // Releasing the file writes its header: only then is it a whole m4a.
        file = nil
        let segment = OutboxItem.Segment(
            index: index,
            file: fileName,
            startMs: Int(Double(framesBefore) / sampleRate * 1_000),
            durationMs: max(Int(Double(framesInSegment) / sampleRate * 1_000), 1)
        )
        framesBefore += framesInSegment
        framesInSegment = 0
        index += 1
        _ = try? store.update(id) {
            $0.segments.append(segment)
            $0.durationMs = segment.startMs + segment.durationMs
        }
        Task { @MainActor [onSegment] in onSegment?() }
    }

    static func rms(_ samples: [Float]) -> Float {
        var sum: Float = 0
        for sample in samples { sum += sample * sample }
        return (sum / Float(max(samples.count, 1))).squareRoot()
    }

    private func report(_ level: Float) {
        let now = Date()
        guard now.timeIntervalSince(lastLevelAt) > 0.1 else { return }
        lastLevelAt = now
        // Speech sits around 0.02–0.2 RMS; spread that over 0...1.
        let shown = Double(min(max(level * 6, 0), 1))
        Task { @MainActor [onLevel] in onLevel?(shown) }
    }
}
