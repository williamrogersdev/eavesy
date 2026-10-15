import AVFoundation
import CoreMedia
import Foundation
import AppKit
import ScreenCaptureKit

final class AudioRecorder: NSObject, Recorder {
    private let outPath: String
    private let source: AudioSource
    private let segmentDir: String?
    private let segmentSec: Double
    private let segmentHardCapSec: Double

    private let writerQueue = DispatchQueue(label: "com.eavesy.swiftaudio.writer")

    private var writer: AVAssetWriter?
    private var audioInput: AVAssetWriterInput?
    private struct OpenSegment {
        let writer: AVAssetWriter
        let input: AVAssetWriterInput
        let path: String
        var level = TrackLevel()
    }
    private var segments: [Track: OpenSegment] = [:]
    private var segmentFirstPTS: CMTime = .zero
    private var segmentLastPTS: CMTime = .zero
    private var segmentIndex = 0
    private var segmentStartMs: Int64 = 0

    private var stream: SCStream?
    private let scOutputQueue = DispatchQueue(label: "com.eavesy.swiftaudio.sc")

    private var captureSession: AVCaptureSession?
    private let micOutputQueue = DispatchQueue(label: "com.eavesy.swiftaudio.mic")

    private var sessionStarted = false
    private var firstPTS: CMTime = .zero
    private var lastPTS: CMTime = .zero
    private var didEmitReady = false
    private var finished = false
    private var sleeping = false
    private var workspaceObservers: [NSObjectProtocol] = []

    private var lastLevelEmit = Date.distantPast

    let mixLock = NSLock()
    var micResidual: [Float] = []
    static let maxMicResidual = 96_000

    func enqueueMicSamples(_ samples: [Float]) {
        guard !samples.isEmpty else { return }
        mixLock.lock()
        defer { mixLock.unlock() }
        micResidual.append(contentsOf: samples)
        if micResidual.count > Self.maxMicResidual {
            micResidual.removeFirst(micResidual.count - Self.maxMicResidual)
        }
    }

    func takeMicSamples(_ count: Int) -> [Float] {
        mixLock.lock()
        defer { mixLock.unlock() }
        let take = min(count, micResidual.count)
        guard take > 0 else { return [] }
        let chunk = Array(micResidual[0..<take])
        micResidual.removeFirst(take)
        return chunk
    }

    init(outPath: String, source: AudioSource, segmentDir: String?, segmentSec: Double) {
        self.outPath = outPath
        self.source = source
        self.segmentDir = segmentDir
        self.segmentSec = segmentSec
        self.segmentHardCapSec = hardCapSec(forSegmentSec: segmentSec)
        super.init()
    }

    func start() {
        setupWriter()
        installSleepWakeObservers()
        startCaptureSources()
    }

    private func startCaptureSources() {
        switch source {
        case .mic:
            requestMicAccessThen { [weak self] in
                self?.startMicCapture()
            }
        case .system:
            startSystemCapture()
        case .mixed:
            requestMicAccessThen { [weak self] in
                self?.startMicCapture()
                self?.startSystemCapture()
            }
        }
    }

    private func setupWriter() {
        let url = URL(fileURLWithPath: outPath)
        try? FileManager.default.removeItem(at: url)
        guard let pair = makeWriter(url: url) else {
            fail("could not create an AAC/M4A AVAssetWriter for \(outPath)")
        }
        writer = pair.0
        audioInput = pair.1
        if let segmentDir {
            do {
                try FileManager.default.createDirectory(
                    atPath: segmentDir, withIntermediateDirectories: true)
            } catch {
                fail("could not create segment directory: \(error.localizedDescription)")
            }
        }
    }

    private func makeWriter(url: URL) -> (AVAssetWriter, AVAssetWriterInput)? {
        let encodings: [[String: Any]] = [
            [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32_000,
            ],
            [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64_000,
            ],
        ]
        for settings in encodings {
            try? FileManager.default.removeItem(at: url)
            let candidate: AVAssetWriter
            do {
                candidate = try AVAssetWriter(outputURL: url, fileType: .m4a)
            } catch {
                FileHandle.standardError.write(
                    Data("M4A writer creation failed: \(error.localizedDescription)\n".utf8))
                continue
            }
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
            input.expectsMediaDataInRealTime = true
            guard candidate.canAdd(input) else {
                let format = settings[AVFormatIDKey] ?? "unknown"
                FileHandle.standardError.write(
                    Data("M4A writer rejected audio format \(format)\n".utf8))
                continue
            }
            candidate.add(input)
            return (candidate, input)
        }
        return nil
    }

    private func installSleepWakeObservers() {
        let center = NSWorkspace.shared.notificationCenter
        workspaceObservers.append(center.addObserver(
            forName: NSWorkspace.willSleepNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.prepareForSleep() })
        workspaceObservers.append(center.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.resumeAfterWake() })
    }

    private func removeSleepWakeObservers() {
        let center = NSWorkspace.shared.notificationCenter
        workspaceObservers.forEach(center.removeObserver)
        workspaceObservers.removeAll()
    }

    private func prepareForSleep() {
        guard !finished, !sleeping else { return }
        sleeping = true
        writerQueue.async { [weak self] in self?.rotateSegment() }
        stopCaptureSources()
    }

    private func resumeAfterWake() {
        guard !finished, sleeping else { return }
        sleeping = false
        startCaptureSources()
    }

    private func stopCaptureSources() {
        if let stream {
            stream.stopCapture { _ in }
            self.stream = nil
        }
        if let captureSession {
            captureSession.stopRunning()
            self.captureSession = nil
        }
    }

    private func requestMicAccessThen(_ next: @escaping () -> Void) {
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            if granted {
                next()
            } else {
                fail("Microphone permission denied")
            }
        }
    }

    private func startMicCapture() {
        guard let device = AVCaptureDevice.default(for: .audio) else {
            fail("no default audio input device available")
        }
        guard let input = try? AVCaptureDeviceInput(device: device) else {
            fail("could not open microphone input")
        }

        let session = AVCaptureSession()
        session.beginConfiguration()
        guard session.canAddInput(input) else {
            fail("capture session cannot add microphone input")
        }
        session.addInput(input)

        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: micOutputQueue)
        guard session.canAddOutput(output) else {
            fail("capture session cannot add audio output")
        }
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()

        self.captureSession = session
    }

    private func startSystemCapture() {
        SCShareableContent.getWithCompletionHandler { [weak self] content, error in
            guard let self else { return }
            if let error {
                fail(
                    "Could not access system audio: \(error.localizedDescription). "
                        + "Check System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen Eavesy."
                )
            }
            guard let content, let display = content.displays.first else {
                fail("Could not find a display to capture system audio from.")
            }

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.sampleRate = 48_000
            config.channelCount = 1
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.showsCursor = false

            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            do {
                try stream.addStreamOutput(
                    self, type: .audio, sampleHandlerQueue: self.scOutputQueue)
                try stream.addStreamOutput(
                    self, type: .screen, sampleHandlerQueue: self.scOutputQueue)
            } catch {
                fail("could not attach SCStream output: \(error.localizedDescription)")
            }

            stream.startCapture { err in
                if let err {
                    fail("could not start system audio capture: \(err.localizedDescription)")
                }
            }
            self.stream = stream
        }
    }

    private var singleTrack: Track { source == .mic ? .mic : .system }

    func appendSingle(_ sampleBuffer: CMSampleBuffer) {
        let samples = Self.toFloatBuffer(sampleBuffer).flatMap { pcm -> [Float]? in
            guard let ch = pcm.floatChannelData else { return nil }
            return Array(UnsafeBufferPointer(start: ch[0], count: Int(pcm.frameLength)))
        } ?? []
        appendAudio(archive: sampleBuffer, tracks: [(singleTrack, sampleBuffer, samples)])
    }

    func appendAudio(archive sampleBuffer: CMSampleBuffer, tracks: [(Track, CMSampleBuffer, [Float])]) {
        let rms = rmsLevel(sampleBuffer)
        writerQueue.async { [weak self] in
            guard let self, !self.finished else { return }
            guard let writer = self.writer, let input = self.audioInput else { return }

            if writer.status == .unknown {
                let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                writer.startWriting()
                writer.startSession(atSourceTime: pts)
                self.firstPTS = pts
                self.sessionStarted = true
            }
            guard writer.status == .writing else { return }

            if input.isReadyForMoreMediaData {
                input.append(sampleBuffer)
                self.lastPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            }

            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            self.ensureSegmentWriters(at: pts, tracks: tracks.map(\.0))
            if !self.segments.isEmpty {
                for (track, buffer, samples) in tracks {
                    guard var open = self.segments[track],
                        open.writer.status == .writing,
                        open.input.isReadyForMoreMediaData
                    else { continue }
                    open.input.append(buffer)
                    open.level.observe(samples)
                    self.segments[track] = open
                }
                self.segmentLastPTS = pts
                let elapsed = CMTimeGetSeconds(CMTimeSubtract(pts, self.segmentFirstPTS))
                let atQuietBoundary = elapsed >= self.segmentSec && (rms ?? 1) < 0.012
                if atQuietBoundary || elapsed >= self.segmentHardCapSec {
                    self.rotateSegment()
                }
            }

            if !self.didEmitReady {
                self.didEmitReady = true
                EventEmitter.ready()
            }
        }
    }

    private func ensureSegmentWriters(at pts: CMTime, tracks: [Track]) {
        guard segments.isEmpty, let segmentDir else { return }
        for track in tracks {
            let path = URL(fileURLWithPath: segmentDir)
                .appendingPathComponent(
                    String(format: "segment-%06d-%@.m4a", segmentIndex, track.rawValue)
                ).path
            guard let pair = makeWriter(url: URL(fileURLWithPath: path)) else {
                FileHandle.standardError.write(Data("could not create segment writer at \(path)\n".utf8))
                continue
            }
            pair.0.startWriting()
            pair.0.startSession(atSourceTime: pts)
            segments[track] = OpenSegment(writer: pair.0, input: pair.1, path: path)
        }
        segmentFirstPTS = pts
        segmentLastPTS = pts
        if sessionStarted {
            segmentStartMs = Int64(max(
                CMTimeGetSeconds(CMTimeSubtract(pts, firstPTS)) * 1000,
                0).rounded())
        }
    }

    private func rotateSegment(completion: (() -> Void)? = nil) {
        guard !segments.isEmpty else {
            completion?()
            return
        }
        let closing = segments
        let oldIndex = segmentIndex
        let oldStartMs = segmentStartMs
        let durationSec = max(
            CMTimeGetSeconds(CMTimeSubtract(segmentLastPTS, segmentFirstPTS)), 0)
        let durationMs = max(Int64((durationSec * 1000).rounded()), 1)

        segments = [:]
        segmentIndex += 1

        let group = DispatchGroup()
        for (track, open) in closing {
            group.enter()
            open.input.markAsFinished()
            open.writer.finishWriting {
                defer { group.leave() }
                let path = open.path
                let bytes = ((try? FileManager.default.attributesOfItem(atPath: path)[.size])
                    as? NSNumber)?.int64Value ?? 0
                guard open.writer.status == .completed, bytes > 0 else {
                    let message = open.writer.error?.localizedDescription ?? "segment finalization failed"
                    EventEmitter.segmentError(message)
                    return
                }
                let manifest: [String: Any] = [
                    "path": path,
                    "index": oldIndex,
                    "track": track.rawValue,
                    "startMs": oldStartMs,
                    "durationMs": durationMs,
                    "bytes": bytes,
                    "peakRms": open.level.peakRms,
                    "activeMs": open.level.activeMs,
                ]
                if let data = try? JSONSerialization.data(withJSONObject: manifest) {
                    try? data.write(
                        to: URL(fileURLWithPath: path + ".json"),
                        options: .atomic)
                }
                EventEmitter.segment(
                    path: path,
                    index: oldIndex,
                    track: track.rawValue,
                    startMs: oldStartMs,
                    durationMs: durationMs,
                    bytes: bytes,
                    peakRms: open.level.peakRms,
                    activeMs: open.level.activeMs)
            }
        }
        group.notify(queue: writerQueue) { completion?() }
    }

    private func emitLevelIfDue(_ sampleBuffer: CMSampleBuffer) {
        let now = Date()
        guard now.timeIntervalSince(lastLevelEmit) >= 0.1 else { return }
        lastLevelEmit = now

        if let rms = rmsLevel(sampleBuffer) {
            EventEmitter.level(rms)
        }
    }

    private func rmsLevel(_ sampleBuffer: CMSampleBuffer) -> Double? {
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }
        var lengthAtOffset = 0
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard
            CMBlockBufferGetDataPointer(
                blockBuffer, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset,
                totalLengthOut: &totalLength, dataPointerOut: &dataPointer) == kCMBlockBufferNoErr,
            let dataPointer, totalLength > 0
        else { return nil }

        guard
            let fmt = CMSampleBufferGetFormatDescription(sampleBuffer),
            let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee
        else { return nil }

        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let bytesPerSample = Int(asbd.mBitsPerChannel / 8)
        guard bytesPerSample > 0 else { return nil }
        let sampleCount = totalLength / bytesPerSample
        guard sampleCount > 0 else { return nil }

        var sumSquares = 0.0
        if isFloat && bytesPerSample == 4 {
            dataPointer.withMemoryRebound(to: Float32.self, capacity: sampleCount) { p in
                for i in 0..<sampleCount {
                    let v = Double(p[i])
                    sumSquares += v * v
                }
            }
        } else if !isFloat && bytesPerSample == 2 {
            dataPointer.withMemoryRebound(to: Int16.self, capacity: sampleCount) { p in
                for i in 0..<sampleCount {
                    let v = Double(p[i]) / Double(Int16.max)
                    sumSquares += v * v
                }
            }
        } else {
            return nil
        }

        return (sumSquares / Double(sampleCount)).squareRoot()
    }

    func stop(completion: @escaping (_ durationSec: Double) -> Void) {
        stopCaptureSources()
        removeSleepWakeObservers()

        writerQueue.async { [weak self] in
            guard let self else {
                completion(0)
                return
            }
            if self.finished {
                completion(0)
                return
            }
            self.finished = true

            guard let writer = self.writer, self.sessionStarted, writer.status == .writing else {
                completion(0)
                return
            }

            let duration = CMTimeGetSeconds(
                CMTimeSubtract(self.lastPTS, self.firstPTS))
            self.rotateSegment {
                self.audioInput?.markAsFinished()
                writer.finishWriting {
                    completion(max(duration, 0))
                }
            }
        }
    }
}

extension AudioRecorder: SCStreamOutput, SCStreamDelegate {
    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio else { return }
        guard CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { return }

        emitLevelIfDue(sampleBuffer)

        if source == .mixed {
            appendMixed(systemBuffer: sampleBuffer)
        } else {
            appendSingle(sampleBuffer)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(
            Data("SCStream stopped: \(error.localizedDescription)\n".utf8))
    }
}

extension AudioRecorder: AVCaptureAudioDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { return }

        if source == .mic {
            emitLevelIfDue(sampleBuffer)
            appendSingle(sampleBuffer)
        } else if source == .mixed {
            if let pcm = Self.toFloatBuffer(sampleBuffer), let ch = pcm.floatChannelData {
                let n = Int(pcm.frameLength)
                enqueueMicSamples(Array(UnsafeBufferPointer(start: ch[0], count: n)))
            }
        }
    }
}
