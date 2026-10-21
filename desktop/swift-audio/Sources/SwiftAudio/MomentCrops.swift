import AVFoundation
import CoreGraphics
import Foundation
import Vision

/// Cuts a close-up of each click and mark out of the screen video, outlines
/// what was pointed at, and reads the text inside it. Stays on the Mac.
enum MomentCrops {
    struct Box: Codable {
        let x: CGFloat
        let y: CGFloat
        let width: CGFloat
        let height: CGFloat
        var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
    }
    struct Point: Codable {
        let x: CGFloat
        let y: CGFloat
    }
    struct Moment: Codable {
        let number: Int
        let kind: String
        let timestampMs: Int64
        let point: Point?
        let rect: Box?
    }
    struct Input: Codable {
        let display: Box
        let moments: [Moment]
    }
    struct Crop: Codable {
        let number: Int
        let path: String
        let width: Int
        let height: Int
        let text: String
    }

    static let padding: CGFloat = 48
    static let minimum = CGSize(width: 360, height: 220)

    static func run(video: URL, moments: URL, folder: URL) async throws {
        let input = try JSONDecoder().decode(Input.self, from: Data(contentsOf: moments))
        let asset = AVURLAsset(url: video)
        let seconds = CMTimeGetSeconds(try await asset.load(.duration))
        guard seconds.isFinite, seconds > 0 else { throw WalkthroughProcessor.error("Video has no duration") }
        let dir = folder.appendingPathComponent("moments", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        var crops: [Crop] = []
        for moment in input.moments {
            // One unreadable frame costs that close-up only.
            do { try autoreleasepool {
                let at = min(max(0, Double(moment.timestampMs) / 1000), max(0, seconds - 1.0 / 30))
                let frame = try generator.copyCGImage(at: CMTime(seconds: at, preferredTimescale: 600), actualTime: nil)
                guard let focus = focusRect(moment), input.display.width > 0 else { return }
                let scale = CGFloat(frame.width) / input.display.width
                let bounds = CGRect(x: 0, y: 0, width: frame.width, height: frame.height)
                let target = inFrame(focus, display: input.display.rect, frameWidth: CGFloat(frame.width)).intersection(bounds)
                guard !target.isNull, target.width >= 1, target.height >= 1 else { return }
                let area = cropRect(around: target, minimum: CGSize(width: minimum.width * scale, height: minimum.height * scale),
                                    padding: padding * scale, in: bounds)
                guard let cropped = frame.cropping(to: area) else { return }
                let text = (frame.cropping(to: target.integral)).map(recognizedText) ?? ""
                let marked = outline(cropped, focus: target.offsetBy(dx: -area.minX, dy: -area.minY),
                                     ring: moment.rect == nil, scale: scale) ?? cropped
                let relative = String(format: "moments/%02d.jpg", moment.number)
                try WalkthroughProcessor.writeImage(marked, to: folder.appendingPathComponent(relative))
                crops.append(Crop(number: moment.number, path: relative, width: marked.width, height: marked.height, text: text))
            } } catch {
                FileHandle.standardError.write(Data("moment \(moment.number): \(error.localizedDescription)\n".utf8))
            }
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(crops).write(to: dir.appendingPathComponent("crops.json"), options: .atomic)
    }

    /// What was pointed at, in display points: the element or area, or a small
    /// square at the click when nothing more is known.
    static func focusRect(_ moment: Moment) -> CGRect? {
        if let rect = moment.rect?.rect, rect.width > 0, rect.height > 0 { return rect }
        guard let point = moment.point else { return nil }
        return CGRect(x: point.x - 12, y: point.y - 12, width: 24, height: 24)
    }

    /// Display points become video pixels, wherever the display sits.
    static func inFrame(_ focus: CGRect, display: CGRect, frameWidth: CGFloat) -> CGRect {
        scaled(focus.offsetBy(dx: -display.minX, dy: -display.minY), by: frameWidth / display.width)
    }

    static func scaled(_ rect: CGRect, by scale: CGFloat) -> CGRect {
        CGRect(x: rect.minX * scale, y: rect.minY * scale, width: rect.width * scale, height: rect.height * scale)
    }

    /// The focus with room around it, at least `minimum` when the frame allows,
    /// moved back inside the frame rather than cut off at its edge.
    static func cropRect(around focus: CGRect, minimum: CGSize, padding: CGFloat, in bounds: CGRect) -> CGRect {
        var area = focus.insetBy(dx: -padding, dy: -padding)
        let width = min(bounds.width, max(area.width, minimum.width))
        let height = min(bounds.height, max(area.height, minimum.height))
        area = CGRect(x: focus.midX - width / 2, y: focus.midY - height / 2, width: width, height: height)
        area.origin.x = min(max(bounds.minX, area.minX), bounds.maxX - area.width)
        area.origin.y = min(max(bounds.minY, area.minY), bounds.maxY - area.height)
        return area.integral.intersection(bounds)
    }

    /// The manila outline the marks wear on screen, drawn into the close-up.
    static func outline(_ image: CGImage, focus: CGRect, ring: Bool, scale: CGFloat) -> CGImage? {
        guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        let height = CGFloat(image.height)
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        // Core Graphics draws from the bottom left; the focus is from the top left.
        let flipped = CGRect(x: focus.minX, y: height - focus.maxY, width: focus.width, height: focus.height)
        let line = max(2, 2.5 * scale)
        context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.9))
        context.setLineWidth(line + 3 * scale)
        if ring { context.strokeEllipse(in: flipped.insetBy(dx: -4 * scale, dy: -4 * scale)) }
        else { context.stroke(flipped.insetBy(dx: -3 * scale, dy: -3 * scale)) }
        context.setStrokeColor(CGColor(red: 0.886, green: 0.722, blue: 0.4, alpha: 1))
        context.setLineWidth(line)
        if ring { context.strokeEllipse(in: flipped.insetBy(dx: -4 * scale, dy: -4 * scale)) }
        else { context.stroke(flipped.insetBy(dx: -3 * scale, dy: -3 * scale)) }
        return context.makeImage()
    }

    static func recognizedText(_ image: CGImage) -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        guard (try? VNImageRequestHandler(cgImage: image).perform([request])) != nil else { return "" }
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}
