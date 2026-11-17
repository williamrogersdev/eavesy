import AVFoundation
import AppKit
import XCTest
@testable import SwiftAudio

final class WalkthroughTests: XCTestCase {
    func frame(_ seconds: Double, label: String) throws -> CMSampleBuffer {
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(nil, 960, 540, kCVPixelFormatType_32ARGB,
                            [kCVPixelBufferCGImageCompatibilityKey: true,
                             kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &buffer)
        let pixels = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(pixels, [])
        let context = try XCTUnwrap(CGContext(data: CVPixelBufferGetBaseAddress(pixels), width: 960, height: 540,
            bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue))
        context.setFillColor(NSColor.white.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: 960, height: 540))
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        (label as NSString).draw(at: NSPoint(x: 50, y: 240), withAttributes: [
            .font: NSFont.systemFont(ofSize: 48), .foregroundColor: NSColor.black,
        ])
        NSGraphicsContext.restoreGraphicsState()
        CVPixelBufferUnlockBaseAddress(pixels, [])
        var description: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pixels, formatDescriptionOut: &description)
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30),
                                       presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: 600), decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: pixels,
            formatDescription: try XCTUnwrap(description), sampleTiming: &timing, sampleBufferOut: &sample)
        return try XCTUnwrap(sample)
    }

    /// The engine pauses whichever recorder it has through the protocol; that
    /// call has to reach the screen recorder, not the do-nothing default.
    func testPausingThroughTheRecorderProtocolReachesTheScreenRecorder() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let recorder = ScreenRecorder(outPath: dir.appendingPathComponent("screen.mp4").path, includeMic: false)
        recorder.setupWriter(width: 960, height: 540)
        let engine: Recorder = recorder
        engine.setPaused(true)
        // Frames stamped after the pause began (it is on the host clock).
        let later = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) + 1
        for index in 0..<10 { recorder.appendVideo(try frame(later + Double(index) / 30, label: "Paused")) }
        let stopped = expectation(description: "stopped")
        recorder.stop { duration in
            XCTAssertEqual(duration, 0, "nothing captured during the pause is written")
            stopped.fulfill()
        }
        await fulfillment(of: [stopped], timeout: 20)
    }

    func testAPausedStretchIsLeftOutOfTheFile() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let video = dir.appendingPathComponent("screen.mp4")
        let recorder = ScreenRecorder(outPath: video.path, includeMic: true)
        recorder.setupWriter(width: 960, height: 540)
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        // Three seconds are captured; the middle one is paused.
        for index in 0..<90 {
            let seconds = Double(index) / 30
            if index == 30 { recorder.setPaused(true, at: CMTime(seconds: seconds, preferredTimescale: 600)) }
            if index == 60 { recorder.setPaused(false, at: CMTime(seconds: seconds, preferredTimescale: 600)) }
            recorder.appendVideo(try frame(seconds, label: index < 30 ? "Before" : index < 60 ? "Secret" : "After"))
            let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1600)!
            pcm.frameLength = 1600
            for n in 0..<1600 { pcm.floatChannelData![0][n] = Float(sin(Double(index * 1600 + n) * 0.03)) * 0.15 }
            recorder.appendMicrophone(try XCTUnwrap(AudioRecorder.toCMSampleBuffer(pcm, pts: CMTime(seconds: seconds, preferredTimescale: 48_000))))
            try await Task.sleep(nanoseconds: 33_333_333)
        }
        let stopped = expectation(description: "finalized")
        recorder.stop { duration in
            XCTAssertEqual(duration, 2, accuracy: 0.15)
            stopped.fulfill()
        }
        await fulfillment(of: [stopped], timeout: 20)
        let asset = AVURLAsset(url: video)
        let length = try await asset.load(.duration)
        XCTAssertEqual(CMTimeGetSeconds(length), 2, accuracy: 0.2)
        let sound = try await asset.loadTracks(withMediaType: .audio)
        let soundRange = try await sound[0].load(.timeRange)
        XCTAssertEqual(CMTimeGetSeconds(soundRange.duration), 2, accuracy: 0.2)
        // The frame at the join is the first one after the pause, never one from inside it.
        let processed = dir.appendingPathComponent("out", isDirectory: true)
        try FileManager.default.createDirectory(at: processed, withIntermediateDirectories: true)
        try await WalkthroughProcessor.run(video: video, folder: processed, audioChunkSeconds: 2) { _ in }
        let manifest = try JSONDecoder().decode(WalkthroughProcessor.Result.self, from: Data(contentsOf: processed.appendingPathComponent("visual.json")))
        let text = manifest.frames.map(\.text).joined(separator: " ")
        XCTAssertTrue(text.contains("Before"))
        XCTAssertTrue(text.contains("After"))
        XCTAssertFalse(text.contains("Secret"))
    }

    func testMicrophoneIsWrittenWithoutAnySystemAudioAndProcessorExtractsEvidence() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer {
            if ProcessInfo.processInfo.environment["EAVESY_KEEP_TEST_MEDIA"] == "1" { print("TEST_MEDIA", dir.path) }
            else { try? FileManager.default.removeItem(at: dir) }
        }
        let video = dir.appendingPathComponent("screen.mp4")
        let recorder = ScreenRecorder(outPath: video.path, includeMic: true)
        recorder.setupWriter(width: 960, height: 540)
        // Feed the actual recorder's writer/delegate path with known narration-like
        // PCM. Deliberately never send a system-audio callback.
        for index in 0..<90 {
            let seconds = Double(index) / 30
            recorder.appendVideo(try frame(seconds, label: index < 60 ? "Checkout screen" : "Address required"))
            let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
            let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1600)!
            pcm.frameLength = 1600
            for n in 0..<1600 { pcm.floatChannelData![0][n] = Float(sin(Double(index * 1600 + n) * 0.03)) * 0.15 }
            let sample = try XCTUnwrap(AudioRecorder.toCMSampleBuffer(pcm, pts: CMTime(seconds: seconds, preferredTimescale: 48_000)))
            recorder.appendMicrophone(sample)
            // Match real-time backpressure rather than overflowing the writer.
            try await Task.sleep(nanoseconds: 33_333_333)
        }
        let stopped = expectation(description: "finalized")
        recorder.stop { duration in
            XCTAssertGreaterThan(duration, 2.8)
            stopped.fulfill()
        }
        await fulfillment(of: [stopped], timeout: 20)
        let stats = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: video.path + ".capture.json"))) as! [String: Any]
        XCTAssertGreaterThan(stats["microphoneSamplesWritten"] as! Int, 48_000)
        XCTAssertGreaterThan(stats["microphonePeakRms"] as! Double, 0.05)
        var early: [WalkthroughProcessor.AudioChunk] = []
        try await WalkthroughProcessor.run(video: video, folder: dir, audioChunkSeconds: 2) { early = $0 }
        XCTAssertEqual(early.map(\.startMs), [0, 2000])
        let manifest = try JSONDecoder().decode(WalkthroughProcessor.Result.self, from: Data(contentsOf: dir.appendingPathComponent("visual.json")))
        XCTAssertGreaterThan(manifest.durationMs, 2800)
        XCTAssertEqual(manifest.audioChunks.count, 2)
        XCTAssertEqual(manifest.audioChunks[1].startMs, 2000)
        XCTAssertEqual(manifest.audioChunks[0].startMs, 0)
        XCTAssertGreaterThan(manifest.frames.count, 1)
        XCTAssertTrue(manifest.frames.map(\.text).joined().contains("Checkout"))
        XCTAssertTrue(manifest.frames.map(\.text).joined().contains("Address"))
        for frame in manifest.frames {
            XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent(frame.path).path))
            XCTAssertGreaterThan(frame.width, 0)
        }
        let tail = AVURLAsset(url: dir.appendingPathComponent(manifest.audioChunks[1].path))
        let tailDuration = try await tail.load(.duration)
        XCTAssertEqual(CMTimeGetSeconds(tailDuration), 1, accuracy: 0.1)
        let tailTracks = try await tail.loadTracks(withMediaType: .audio)
        let tailRange = try await tailTracks[0].load(.timeRange)
        XCTAssertLessThan(CMTimeGetSeconds(tailRange.start), 0.05, "Chunk timing must reset to zero before STT")
        let audio = AVURLAsset(url: dir.appendingPathComponent(manifest.audioChunks[0].path))
        let tracks = try await audio.loadTracks(withMediaType: .audio)
        XCTAssertEqual(tracks.count, 1)
        // Decode exported AAC and prove it contains the microphone signal.
        let reader = try AVAssetReader(asset: audio)
        let output = AVAssetReaderTrackOutput(track: tracks[0], outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMIsFloatKey: true,
            AVLinearPCMBitDepthKey: 32, AVLinearPCMIsNonInterleaved: false,
        ])
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        var peak: Float = 0
        while let sample = output.copyNextSampleBuffer() {
            if let pcm = AudioRecorder.toFloatBuffer(sample), let ch = pcm.floatChannelData {
                for i in 0..<Int(pcm.frameLength) { peak = max(peak, abs(ch[0][i])) }
            }
        }
        XCTAssertGreaterThan(peak, 0.05)
        try WalkthroughProcessor.extractFrame(video: video, seconds: 1, output: dir.appendingPathComponent("requested.jpg"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("requested.jpg").path))
    }
}
