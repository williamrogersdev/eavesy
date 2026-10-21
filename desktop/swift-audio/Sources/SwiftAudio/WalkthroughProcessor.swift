import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

/// All visual processing stays on the Mac. No screenshot upload or Python/ffmpeg dependency.
enum WalkthroughProcessor {
    struct AudioChunk: Codable {
        let path: String
        let startMs: Int64
        let durationMs: Int64
    }
    struct TextRegion: Codable {
        let text: String
        let confidence: Float
        // Normalized coordinates with the origin at the top left.
        let x: CGFloat
        let y: CGFloat
        let width: CGFloat
        let height: CGFloat
    }
    struct Frame: Codable {
        let timestampMs: Int64
        let path: String
        let width: Int
        let height: Int
        let text: String
        let regions: [TextRegion]
    }
    struct Result: Codable {
        let durationMs: Int64
        let sampleIntervalMs: Int64
        let frames: [Frame]
        let audioChunks: [AudioChunk]
        let warnings: [String]
    }

    static func run(video: URL, folder: URL, audioChunkSeconds: Double = 120) async throws {
        guard audioChunkSeconds.isFinite, audioChunkSeconds >= 1, audioChunkSeconds <= 120
        else { throw error("Invalid audio chunk duration") }
        let asset = AVURLAsset(url: video)
        let duration = try await asset.load(.duration)
        let seconds = CMTimeGetSeconds(duration)
        guard seconds.isFinite, seconds > 0 else { throw error("Video has no duration") }
        let framesDir = folder.appendingPathComponent("frames", isDirectory: true)
        let audioDir = folder.appendingPathComponent("audio", isDirectory: true)
        try FileManager.default.createDirectory(at: framesDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: audioDir, withIntermediateDirectories: true)
        var warnings: [String] = []
        var chunks: [AudioChunk] = []
        // Bounded uploads, with offsets in the same timebase as screenshots/video.
        if !(try await asset.loadTracks(withMediaType: .audio)).isEmpty {
            for start in stride(from: 0.0, to: seconds, by: audioChunkSeconds) {
                let length = min(audioChunkSeconds, seconds - start)
                let relative = String(format: "audio/%08d.m4a", Int(start * 1000))
                let target = folder.appendingPathComponent(relative)
                try? FileManager.default.removeItem(at: target)
                guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A)
                else { warnings.append("Could not create audio export at \(start) s"); continue }
                export.outputURL = target
                export.outputFileType = .m4a
                export.timeRange = CMTimeRange(
                    start: CMTime(seconds: start, preferredTimescale: 600),
                    duration: CMTime(seconds: length, preferredTimescale: 600))
                await export.export()
                guard export.status == .completed else {
                    warnings.append("Audio extraction failed at \(start) s: \(export.error?.localizedDescription ?? "unknown error")")
                    continue
                }
                chunks.append(AudioChunk(path: relative, startMs: Int64(start * 1000), durationMs: Int64(length * 1000)))
            }
        } else { warnings.append("No audio track was recorded; narration is unavailable.") }

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 3200, height: 3200)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        // At most 241 candidates; repeated static screens are removed. Explicitly
        // record the sampling interval so agents know this is a sampled timeline.
        let interval = max(2.0, seconds / 240.0)
        var frames: [Frame] = []
        var previous: [UInt8]?
        var previousText: String?
        var lastSaved = -Double.infinity
        // Include the final screen even when a short clip ends before the next sample.
        let sampleTimes = Array(stride(from: 0.0, to: seconds, by: interval)) + [max(0, seconds - 1.0 / 30)]
        for time in sampleTimes {
            autoreleasepool {
                do {
                    var actual = CMTime.zero
                    let image = try generator.copyCGImage(
                        at: CMTime(seconds: time, preferredTimescale: 600), actualTime: &actual)
                    let thumb = thumbnail(image)
                    let ms = max(0, Int64((CMTimeGetSeconds(actual) * 1000).rounded()))
                    if frames.last?.timestampMs == ms { return }
                    let relative = String(format: "frames/%09lld.jpg", ms)
                    var regions: [TextRegion] = []
                    do {
                        let request = VNRecognizeTextRequest()
                        request.recognitionLevel = .accurate
                        request.usesLanguageCorrection = false
                        try VNImageRequestHandler(cgImage: image).perform([request])
                        regions = (request.results ?? []).compactMap { observation in
                            guard let candidate = observation.topCandidates(1).first else { return nil }
                            let b = observation.boundingBox
                            return TextRegion(text: candidate.string, confidence: candidate.confidence,
                                              x: b.minX, y: 1 - b.maxY, width: b.width, height: b.height)
                        }
                    } catch { warnings.append("Screen text extraction failed at \(ms) ms: \(error.localizedDescription)") }
                    let text = regions.map(\.text).joined(separator: "\n")
                    // Tiny label/error changes can be invisible in a thumbnail.
                    // Compare recognized text too before deduplicating a screen.
                    if let previous, difference(previous, thumb) < 3,
                       text == previousText, time - lastSaved < 15 { return }
                    try writeImage(image, to: folder.appendingPathComponent(relative))
                    frames.append(Frame(timestampMs: ms, path: relative, width: image.width, height: image.height,
                                        text: regions.map(\.text).joined(separator: "\n"), regions: regions))
                    previous = thumb
                    previousText = text
                    lastSaved = time
                } catch { warnings.append("Screenshot extraction failed at \(time) s: \(error.localizedDescription)") }
            }
        }
        let result = Result(durationMs: Int64(seconds * 1000), sampleIntervalMs: Int64(interval * 1000),
                            frames: frames, audioChunks: chunks, warnings: warnings)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(result).write(to: folder.appendingPathComponent("visual.json"), options: .atomic)
    }

    static func extractFrame(video: URL, seconds: Double, output: URL) throws {
        guard seconds.isFinite, seconds >= 0 else { throw error("Invalid frame timestamp") }
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: video))
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let image = try generator.copyCGImage(at: CMTime(seconds: seconds, preferredTimescale: 600), actualTime: nil)
        try writeImage(image, to: output)
    }

    static func writeImage(_ image: CGImage, to url: URL) throws {
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { throw error("Could not create screenshot") }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.88] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw error("Could not write screenshot") }
    }

    static func thumbnail(_ image: CGImage) -> [UInt8] {
        var pixels = [UInt8](repeating: 0, count: 32 * 18)
        pixels.withUnsafeMutableBytes { buffer in
            if let context = CGContext(data: buffer.baseAddress, width: 32, height: 18, bitsPerComponent: 8,
                                       bytesPerRow: 32, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) {
                context.draw(image, in: CGRect(x: 0, y: 0, width: 32, height: 18))
            }
        }
        return pixels
    }

    static func difference(_ a: [UInt8], _ b: [UInt8]) -> Double {
        guard !a.isEmpty, a.count == b.count else { return .infinity }
        return Double(zip(a, b).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }) / Double(a.count)
    }
    static func error(_ message: String) -> NSError {
        NSError(domain: "Eavesy.Walkthrough", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
