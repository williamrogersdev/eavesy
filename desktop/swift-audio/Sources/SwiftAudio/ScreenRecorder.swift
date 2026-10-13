import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

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

    private let mixLock = NSLock()
    private var micResidual: [Float] = []
    private static let maxMicResidual = 96_000

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
                if granted {
                    self?.startMicCapture()
                }
                self?.startScreenCapture()
            }
        } else {
            startScreenCapture()
        }
    }

    private func setupWriter(width: Int, height: Int) {
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

    private func startMicCapture() {
        guard let device = AVCaptureDevice.default(for: .audio),
            let input = try? AVCaptureDeviceInput(device: device)
        else { return }

        let session = AVCaptureSession()
        session.beginConfiguration()
        guard session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: micOutputQueue)
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()
        self.captureSession = session
    }

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

    private func appendVideo(_ sampleBuffer: CMSampleBuffer) {
        writerQueue.async { [weak self] in
            guard let self, !self.finished else { return }
            guard let input = self.videoInput else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            guard self.startSessionIfNeeded(at: pts) else { return }
            if input.isReadyForMoreMediaData {
                input.append(sampleBuffer)
                self.lastPTS = pts
            }
            if !self.didEmitReady {
                self.didEmitReady = true
                EventEmitter.ready()
            }
        }
    }

    private func appendAudio(_ sampleBuffer: CMSampleBuffer) {
        writerQueue.async { [weak self] in
            guard let self, !self.finished else { return }
            guard let input = self.audioInput else { return }
            guard self.writer?.status == .writing, self.sessionStarted else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            guard CMTimeCompare(pts, self.firstPTS) >= 0 else { return }
            if input.isReadyForMoreMediaData {
                input.append(sampleBuffer)
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

    private func mixedSystemBuffer(_ systemBuffer: CMSampleBuffer) -> CMSampleBuffer {
        guard let sysPCM = AudioRecorder.toFloatBuffer(systemBuffer),
            let sysCh = sysPCM.floatChannelData
        else { return systemBuffer }

        let sysCount = Int(sysPCM.frameLength)
        mixLock.lock()
        let take = min(sysCount, micResidual.count)
        let micSamples = take > 0 ? Array(micResidual[0..<take]) : []
        if take > 0 { micResidual.removeFirst(take) }
        mixLock.unlock()

        let mixCount = min(sysCount, micSamples.count)
        guard mixCount > 0 else { return systemBuffer }
        for i in 0..<mixCount {
            var v = sysCh[0][i] + micSamples[i]
            if v > 1.0 { v = 1.0 } else if v < -1.0 { v = -1.0 }
            sysCh[0][i] = v
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(systemBuffer)
        return AudioRecorder.toCMSampleBuffer(sysPCM, pts: pts) ?? systemBuffer
    }

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
            guard let writer = self.writer, self.sessionStarted, writer.status == .writing else {
                completion(0)
                return
            }
            let duration = CMTimeGetSeconds(CMTimeSubtract(self.lastPTS, self.firstPTS))
            self.videoInput?.markAsFinished()
            self.audioInput?.markAsFinished()
            writer.finishWriting {
                guard writer.status == .completed else {
                    let reason = writer.error?.localizedDescription ?? "unknown AVAssetWriter error"
                    fail("could not finalize screen recording: \(reason)")
                }
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

extension ScreenRecorder: SCStreamOutput, SCStreamDelegate {
    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        switch type {
        case .screen:
            guard sampleBuffer.isValidScreenFrame else { return }
            appendVideo(sampleBuffer)
        case .audio:
            guard CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { return }
            emitLevelIfDue(sampleBuffer)
            let buffer = includeMic ? mixedSystemBuffer(sampleBuffer) : sampleBuffer
            appendAudio(buffer)
        default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(
            Data("SCStream stopped: \(error.localizedDescription)\n".utf8))
    }
}

extension ScreenRecorder: AVCaptureAudioDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { return }
        guard let pcm = AudioRecorder.toFloatBuffer(sampleBuffer),
            let ch = pcm.floatChannelData
        else { return }
        let n = Int(pcm.frameLength)
        mixLock.lock()
        micResidual.append(contentsOf: UnsafeBufferPointer(start: ch[0], count: n))
        if micResidual.count > Self.maxMicResidual {
            micResidual.removeFirst(micResidual.count - Self.maxMicResidual)
        }
        mixLock.unlock()
    }
}

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
