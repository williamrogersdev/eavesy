import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// Records the main display's video (H.264) plus system audio (AAC) into an .mp4
// via AVAssetWriter. Narrated capture uses the microphone as the audio clock,
// so narration is written even when the computer produces no system sound.
final class ScreenRecorder: NSObject, Recorder {
    private let outPath: String
    private let includeMic: Bool

    private let writerQueue = DispatchQueue(label: "com.eavesy.swiftaudio.swriter")
    private let scOutputQueue = DispatchQueue(label: "com.eavesy.swiftaudio.ssc")
    private let micOutputQueue = DispatchQueue(label: "com.eavesy.swiftaudio.smic")

    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?

    private var stream: SCStream?
    private var captureSession: AVCaptureSession?

    private var sessionStarted = false
    private var firstPTS: CMTime = .zero
    private var lastPTS: CMTime = .zero
    private var didEmitReady = false
    private var finished = false
    private var lastLevelEmit = Date.distantPast

    // The microphone drives narrated audio; system audio is optional in the mix.
    private let mixLock = NSLock()
    private var systemResidual: [Float] = []
    private var micSamplesWritten = 0
    private var micPeakRms = 0.0

    private var displayWidth = 1920
    private var displayHeight = 1080

    init(outPath: String, includeMic: Bool) {
        self.outPath = outPath
        self.includeMic = includeMic
        super.init()
    }

    func start() {
        if includeMic {
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                guard granted else { fail("Microphone permission denied. Enable Microphone access in System Settings.") }
                self?.startMicCapture()
                self?.startScreenCapture()
            }
        } else {
            startScreenCapture()
        }
    }

    func setupWriter(width: Int, height: Int) {
        let url = URL(fileURLWithPath: outPath)
        try? FileManager.default.removeItem(at: url)

        guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else {
            fail("could not create AVAssetWriter for \(outPath)")
        }

        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
        ]
        let vInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        vInput.expectsMediaDataInRealTime = true
        guard writer.canAdd(vInput) else { fail("AVAssetWriter cannot add video input") }
        writer.add(vInput)

        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 128_000,
        ]
        let aInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        aInput.expectsMediaDataInRealTime = true
        guard writer.canAdd(aInput) else { fail("AVAssetWriter cannot add audio input") }
        writer.add(aInput)

        self.writer = writer
        self.videoInput = vInput
        self.audioInput = aInput
    }

    // MARK: - Microphone

    private func startMicCapture() {
        guard let device = AVCaptureDevice.default(for: .audio),
            let input = try? AVCaptureDeviceInput(device: device)
        else { fail("Could not open the microphone. Check the selected input device.") }

        let session = AVCaptureSession()
        session.beginConfiguration()
        guard session.canAddInput(input) else { fail("Could not attach microphone input") }
        session.addInput(input)
        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: micOutputQueue)
        guard session.canAddOutput(output) else { fail("Could not attach microphone output") }
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()
        guard session.isRunning else { fail("Microphone did not start") }
        self.captureSession = session
    }

    // MARK: - Screen + system audio

    private func startScreenCapture() {
        SCShareableContent.getWithCompletionHandler { [weak self] content, error in
            guard let self else { return }
            if let error {
                fail(
                    "Could not access screen capture: \(error.localizedDescription). "
                        + "Check System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen Eavesy."
                )
            }
            guard let content, let display = captureDisplay(content) else {
                fail("Could not find a display to record.")
            }

            self.displayWidth = display.width
            self.displayHeight = display.height
            self.setupWriter(width: display.width, height: display.height)

            let excluded = content.applications.filter { $0.bundleIdentifier == "com.eavesy.desktop" }
            let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.sampleRate = 48_000
            config.channelCount = 1
            config.width = display.width
            config.height = display.height
            config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = true

            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            do {
                try stream.addStreamOutput(
                    self, type: .screen, sampleHandlerQueue: self.scOutputQueue)
                try stream.addStreamOutput(
                    self, type: .audio, sampleHandlerQueue: self.scOutputQueue)
            } catch {
                fail("could not attach SCStream output: \(error.localizedDescription)")
            }

            stream.startCapture { err in
                if let err {
                    fail("could not start screen capture: \(err.localizedDescription)")
                }
            }
            self.stream = stream
        }
    }

    // MARK: - Appending

    private func startSessionIfNeeded(at pts: CMTime) -> Bool {
        guard let writer = self.writer else { return false }
        if writer.status == .unknown {
            writer.startWriting()
            writer.startSession(atSourceTime: pts)
            firstPTS = pts
            sessionStarted = true
        }
        return writer.status == .writing
    }

    func appendVideo(_ sampleBuffer: CMSampleBuffer) {
        writerQueue.async { [weak self] in
            guard let self, !self.finished else { return }
            guard let input = self.videoInput else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            guard self.startSessionIfNeeded(at: pts) else { return }
            if input.isReadyForMoreMediaData {
                guard input.append(sampleBuffer) else {
                    EventEmitter.warning("Video writing stopped: \(self.writer?.error?.localizedDescription ?? "unknown error")")
                    DispatchQueue.main.async { gracefulStop() }
                    return
                }
                self.lastPTS = pts
            }
            if !self.includeMic && !self.didEmitReady {
                self.didEmitReady = true
                EventEmitter.ready()
            }
        }
    }

    private func appendAudio(_ sampleBuffer: CMSampleBuffer, isMic: Bool = false) {
        writerQueue.async { [weak self] in
            guard let self, !self.finished else { return }
            guard let input = self.audioInput else { return }
            // Only append audio once the session has begun (video starts it).
            // Drop audio that precedes the first video frame to keep A/V aligned.
            guard self.writer?.status == .writing, self.sessionStarted else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            guard CMTimeCompare(pts, self.firstPTS) >= 0 else { return }
            if input.isReadyForMoreMediaData {
                guard input.append(sampleBuffer) else {
                    EventEmitter.warning("Audio writing stopped: \(self.writer?.error?.localizedDescription ?? "unknown error")")
                    DispatchQueue.main.async { gracefulStop() }
                    return
                }
                if isMic {
                    self.micSamplesWritten += CMSampleBufferGetNumSamples(sampleBuffer)
                    if !self.didEmitReady {
                        self.didEmitReady = true
                        EventEmitter.ready()
                    }
                }
            }
        }
    }

    private func emitLevelIfDue(_ sampleBuffer: CMSampleBuffer) {
        let now = Date()
        guard now.timeIntervalSince(lastLevelEmit) >= 0.1 else { return }
        lastLevelEmit = now
        guard let pcm = AudioRecorder.toFloatBuffer(sampleBuffer),
            let ch = pcm.floatChannelData
        else { return }
        let n = Int(pcm.frameLength)
        guard n > 0 else { return }
        var sum = 0.0
        for i in 0..<n {
            let v = Double(ch[0][i])
            sum += v * v
        }
        EventEmitter.level((sum / Double(n)).squareRoot())
    }

    // Mix optional computer sound into each microphone buffer. Never wait for
    // a system-audio callback to preserve speech (including on a silent desktop).
    private func mixedMicrophoneBuffer(_ microphone: CMSampleBuffer) -> CMSampleBuffer? {
        guard let pcm = AudioRecorder.toFloatBuffer(microphone), let ch = pcm.floatChannelData
        else { EventEmitter.warning("Skipped an undecodable microphone buffer"); return nil }
        let count = Int(pcm.frameLength)
        mixLock.lock()
        let take = min(count, systemResidual.count)
        let system = Array(systemResidual.prefix(take))
        systemResidual.removeFirst(take)
        mixLock.unlock()
        var sum = 0.0
        for i in 0..<count {
            let mic = ch[0][i]
            sum += Double(mic * mic)
            if i < system.count { ch[0][i] = min(1, max(-1, mic + system[i])) }
        }
        mixLock.lock()
        if count > 0 { micPeakRms = max(micPeakRms, sqrt(sum / Double(count))) }
        mixLock.unlock()
        return AudioRecorder.toCMSampleBuffer(pcm, pts: CMSampleBufferGetPresentationTimeStamp(microphone))
            ?? microphone
    }

    // Shared by the capture delegate and the synthetic no-system-audio test.
    func appendMicrophone(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { return }
        emitLevelIfDue(sampleBuffer)
        if let mixed = mixedMicrophoneBuffer(sampleBuffer) { appendAudio(mixed, isMic: true) }
    }

    // MARK: - Stop

    func stop(completion: @escaping (_ durationSec: Double) -> Void) {
        if let stream {
            stream.stopCapture { _ in }
            self.stream = nil
        }
        if let captureSession {
            captureSession.stopRunning()
            self.captureSession = nil
        }

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
            if self.writer?.status == .failed {
                // This writer cannot be salvaged. Avoid the generic fail() salvage loop.
                EventEmitter.error("Recording could not be saved because the video writer failed: \(self.writer?.error?.localizedDescription ?? "unknown error")")
                fflush(stdout)
                exit(1)
            }
            guard let writer = self.writer, self.sessionStarted, writer.status == .writing else {
                completion(0)
                return
            }
            let duration = CMTimeGetSeconds(CMTimeSubtract(self.lastPTS, self.firstPTS))
            self.videoInput?.markAsFinished()
            self.audioInput?.markAsFinished()
            writer.finishWriting {
                guard writer.status == .completed else {
                    fail("Could not finalize video: \(writer.error?.localizedDescription ?? "unknown error")")
                }
                self.mixLock.lock()
                let peak = self.micPeakRms
                self.mixLock.unlock()
                let stats: [String: Any] = [
                    "microphoneEnabled": self.includeMic,
                    "microphoneSamplesWritten": self.micSamplesWritten,
                    "microphoneSampleRate": 48000,
                    "microphonePeakRms": peak,
                ]
                do {
                    try JSONSerialization.data(withJSONObject: stats, options: [.sortedKeys])
                        .write(to: URL(fileURLWithPath: self.outPath + ".capture.json"), options: .atomic)
                } catch { EventEmitter.warning("Could not save microphone verification: \(error.localizedDescription)") }
                self.exportCanonicalAudio(durationSec: max(duration, 0), completion: completion)
            }
        }
    }

    private func exportCanonicalAudio(
        durationSec: Double,
        completion: @escaping (_ durationSec: Double) -> Void
    ) {
        let videoURL = URL(fileURLWithPath: outPath)
        let audioURL = videoURL.deletingPathExtension().appendingPathExtension("m4a")
        try? FileManager.default.removeItem(at: audioURL)

        let asset = AVURLAsset(url: videoURL)
        guard
            let exporter = AVAssetExportSession(
                asset: asset,
                presetName: AVAssetExportPresetAppleM4A)
        else {
            fail("could not prepare the canonical audio export")
        }
        guard exporter.supportedFileTypes.contains(.m4a) else {
            fail("this Mac cannot export screen-recording audio as M4A")
        }
        exporter.outputURL = audioURL
        exporter.outputFileType = .m4a
        exporter.exportAsynchronously {
            guard
                exporter.status == .completed,
                FileManager.default.fileExists(atPath: audioURL.path)
            else {
                let reason =
                    exporter.error?.localizedDescription ?? "unknown AVAssetExportSession error"
                fail("could not export screen-recording audio: \(reason)")
            }
            completion(durationSec)
        }
    }
}

// MARK: - SCStreamOutput / SCStreamDelegate

extension ScreenRecorder: SCStreamOutput, SCStreamDelegate {
    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        switch type {
        case .screen:
            // Only append frames the system marks as complete/valid.
            guard sampleBuffer.isValidScreenFrame else { return }
            appendVideo(sampleBuffer)
        case .audio:
            guard CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { return }
            if includeMic {
                guard let pcm = AudioRecorder.toFloatBuffer(sampleBuffer), let ch = pcm.floatChannelData else { return }
                mixLock.lock()
                systemResidual.append(contentsOf: UnsafeBufferPointer(start: ch[0], count: Int(pcm.frameLength)))
                // Bound latency and memory if callback rates briefly diverge.
                if systemResidual.count > 12_000 { systemResidual.removeFirst(systemResidual.count - 12_000) }
                mixLock.unlock()
            } else {
                emitLevelIfDue(sampleBuffer)
                appendAudio(sampleBuffer)
            }
        default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        EventEmitter.error("Screen capture stopped: \(error.localizedDescription)")
    }
}

// MARK: - AVCaptureAudioDataOutputSampleBufferDelegate

extension ScreenRecorder: AVCaptureAudioDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        appendMicrophone(sampleBuffer)
    }
}

// Helper to validate ScreenCaptureKit video frames before appending.
extension CMSampleBuffer {
    var isValidScreenFrame: Bool {
        guard CMSampleBufferGetImageBuffer(self) != nil else { return false }
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                self, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let info = attachments.first,
            let statusRaw = info[.status] as? Int,
            let status = SCFrameStatus(rawValue: statusRaw)
        else { return false }
        return status == .complete
    }
}
