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
            self?.queue.async { self?.write(buffer) }
        }
        engine.prepare()
        try engine.start()

        interruption = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            Task { @MainActor in self?.onInterrupted?() }
        }
    }

    /// Seals the last segment and hands the recording to the sync engine.
    func stop() {
        if let interruption { NotificationCenter.default.removeObserver(interruption) }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        queue.sync {
            guard !stopped else { return }
            stopped = true
            seal()
            let totalMs = Int(Double(framesBefore) / sampleRate * 1_000)
            _ = try? store.update(id) {
                $0.state = .pending
                $0.durationMs = totalMs
            }
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: On the recorder queue

    private func write(_ buffer: AVAudioPCMBuffer) {
        guard !stopped, buffer.frameLength > 0, let source = buffer.floatChannelData else { return }
        do {
            if file == nil { try open() }
            guard let file, let mono = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: buffer.frameLength),
                  let target = mono.floatChannelData else { return }
            // The first channel is the voice; a stereo input repeats it.
            mono.frameLength = buffer.frameLength
            target[0].update(from: source[0], count: Int(buffer.frameLength))
            try file.write(from: mono)
            framesInSegment += Int64(buffer.frameLength)

            let level = rms(source[0], Int(buffer.frameLength))
            report(level)
            let seconds = Double(framesInSegment) / sampleRate
            if seconds >= Self.maxSec || (seconds >= Self.targetSec && level < Self.quietRms) { seal() }
        } catch {
            // A segment that can't be written is dropped; the ones already sealed stay.
            file = nil
            framesInSegment = 0
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

    private func rms(_ samples: UnsafePointer<Float>, _ count: Int) -> Float {
        var sum: Float = 0
        for i in 0..<count { sum += samples[i] * samples[i] }
        return (sum / Float(max(count, 1))).squareRoot()
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
