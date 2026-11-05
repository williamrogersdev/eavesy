import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// Snapshots: while a meeting records, a picture of the shared screen every
// time it changes. The meeting window (or the display under the pointer when
// no meeting window can be found) is sampled every few seconds; a sample is
// kept only when it has settled (a perceptual hash matches the previous
// sample's), looks like shared content rather than a grid of cameras, differs
// enough from the last one kept, and comes at least `minInterval` after it.
//
// Kept frames are JPEGs in `--snapshots-dir`, named by their offset into the
// recording (`snapshot-000123456.jpg` is 123.456 s in). The host reads the
// folder, so a crash never loses one that was written.

/// What a sample looks like, reduced to what the detector needs.
struct SnapshotFeatures: Equatable {
    /// Difference hash of a 33×32 greyscale thumbnail: 1024 bits. Coarse, so a
    /// small camera tile over a share barely moves it: says whether a picture settled.
    let hash: [UInt64]
    /// 128×72 greyscale thumbnail: fine enough to see a new line of text.
    let thumb: [UInt8]
    /// Share of neighbouring pixels with exactly the same value. Slides, documents
    /// and designs are mostly flat; camera video is noise and gradients.
    let flatRatio: Double
    /// Standard deviation of the brightness, 0–255. A blank or paused share is near 0.
    let contrast: Double

    static let hashWidth = 33
    static let hashHeight = 32
    static let flatWidth = 256
    static let flatHeight = 144
    static let thumbWidth = 128
    static let thumbHeight = 72
    /// A thumbnail pixel this much brighter or darker counts as changed.
    static let pixelChange = 24

    /// Features from greyscale pixels, all row-major: the hash thumbnail
    /// (33×32), the comparison thumbnail (128×72) and the texture sample (256×144).
    static func from(hashPixels: [UInt8], thumbPixels: [UInt8], flatPixels: [UInt8]) -> SnapshotFeatures {
        precondition(hashPixels.count == hashWidth * hashHeight)
        var words = [UInt64](repeating: 0, count: (hashWidth - 1) * hashHeight / 64)
        var bit = 0
        for row in 0..<hashHeight {
            for column in 0..<(hashWidth - 1) {
                let left = hashPixels[row * hashWidth + column]
                let right = hashPixels[row * hashWidth + column + 1]
                if left > right { words[bit / 64] |= 1 << UInt64(bit % 64) }
                bit += 1
            }
        }
        var flat = 0
        var pairs = 0
        var sum = 0.0
        var squares = 0.0
        let width = flatWidth
        let rows = flatPixels.count / width
        for row in 0..<rows {
            for column in 0..<width {
                let value = flatPixels[row * width + column]
                sum += Double(value)
                squares += Double(value) * Double(value)
                if column + 1 < width {
                    pairs += 1
                    if value == flatPixels[row * width + column + 1] { flat += 1 }
                }
            }
        }
        let count = Double(max(flatPixels.count, 1))
        let mean = sum / count
        let variance = max(0, squares / count - mean * mean)
        return SnapshotFeatures(
            hash: words, thumb: thumbPixels, flatRatio: pairs == 0 ? 0 : Double(flat) / Double(pairs), contrast: variance.squareRoot())
    }

    /// Share of thumbnail pixels that changed, 0–1.
    func changed(from other: SnapshotFeatures) -> Double {
        guard thumb.count == other.thumb.count, !thumb.isEmpty else { return 1 }
        let changed = zip(thumb, other.thumb).reduce(0) { $0 + (abs(Int($1.0) - Int($1.1)) > Self.pixelChange ? 1 : 0) }
        return Double(changed) / Double(thumb.count)
    }

    /// Share of hash bits that differ, 0–1.
    func distance(to other: SnapshotFeatures) -> Double {
        guard hash.count == other.hash.count, !hash.isEmpty else { return 1 }
        let differing = zip(hash, other.hash).reduce(0) { $0 + ($1.0 ^ $1.1).nonzeroBitCount }
        return Double(differing) / Double(hash.count * 64)
    }
}

/// Decides which samples become Snapshots. Pure, so it is tested without a screen.
struct SnapshotDetector {
    enum Decision: Equatable {
        case keep
        /// Still changing since the last sample (a transition, scrolling, video).
        case moving
        /// Looks like camera video rather than shared content.
        case camera
        /// Nothing on it (a black or paused share).
        case blank
        /// Too close to the last Snapshot kept.
        case unchanged
        /// Changed, but too soon after the last Snapshot; asked again next sample.
        case tooSoon
    }

    /// Two samples whose hashes are this close show the same picture: a share
    /// with a speaker tile in the corner, or a clock ticking, still counts as settled.
    var stableBelow = 0.03
    /// A Snapshot changes at least this share of thumbnail pixels from the last one
    /// kept: a new slide, or a new line of a slide. A speaker tile stays under it.
    var changedFrom = 0.04
    /// Shared content has at least this share of flat neighbouring pixels.
    var minFlatRatio = 0.4
    var minContrast = 6.0
    /// Seconds between two Snapshots, at least.
    var minInterval: TimeInterval = 8

    private var previous: SnapshotFeatures?
    private var lastKept: SnapshotFeatures?
    private var lastKeptAt: TimeInterval?

    /// `at`: seconds into the recording.
    mutating func consider(_ features: SnapshotFeatures, at: TimeInterval) -> Decision {
        let before = previous
        previous = features
        guard let before, features.distance(to: before) <= stableBelow else { return .moving }
        guard features.contrast >= minContrast else { return .blank }
        guard features.flatRatio >= minFlatRatio else { return .camera }
        if let lastKept, features.changed(from: lastKept) < changedFrom { return .unchanged }
        if let lastKeptAt, at - lastKeptAt < minInterval { return .tooSoon }
        lastKept = features
        lastKeptAt = at
        return .keep
    }
}

enum SnapshotFiles {
    /// `snapshot-000123456.jpg` for 123 456 ms; the host parses the same shape.
    static func name(offsetMs: Int64) -> String {
        let digits = String(max(offsetMs, 0))
        return "snapshot-" + String(repeating: "0", count: max(0, 9 - digits.count)) + digits + ".jpg"
    }
}

/// Meeting apps whose window holds the shared screen, and browser tab titles that name a call.
enum MeetingWindows {
    static let apps: Set<String> = [
        "us.zoom.xos", "com.microsoft.teams2", "com.microsoft.teams", "com.cisco.webexmeetingsapp",
        "Cisco-Systems.Spark", "com.apple.FaceTime", "com.tinyspeck.slackmacgap",
    ]
    static let browsers: Set<String> = [
        "com.google.Chrome", "com.apple.Safari", "company.thebrowser.Browser", "org.mozilla.firefox",
        "com.microsoft.edgemac", "com.brave.Browser",
    ]
    static let callTitles = ["Meet - ", "Meet – ", "Google Meet", "Microsoft Teams", "Zoom", "Webex", "Whereby", "Around"]

    struct Candidate: Equatable {
        let bundle: String
        let title: String
        let width: CGFloat
        let height: CGFloat
        let onScreen: Bool
        let layer: Int
    }

    /// The window most likely to show the call: the largest normal window of a
    /// meeting app, else of a browser tab titled like a call. Nil when there is none.
    static func pick(_ windows: [Candidate]) -> Int? {
        func usable(_ window: Candidate) -> Bool {
            window.onScreen && window.layer == 0 && window.width >= 480 && window.height >= 320
        }
        let ranked = windows.enumerated().filter { usable($0.element) }
        let app = ranked.filter { apps.contains($0.element.bundle) }
        let browser = ranked.filter { candidate in
            browsers.contains(candidate.element.bundle)
                && callTitles.contains { candidate.element.title.contains($0) }
        }
        let pool = app.isEmpty ? browser : app
        return pool.max { $0.element.width * $0.element.height < $1.element.width * $1.element.height }?.offset
    }
}

/// Samples the screen while a capture runs and writes the Snapshots it keeps.
final class SnapshotSampler {
    static let sampleEvery: TimeInterval = 2.5
    /// Snapshots are stored no wider or taller than this, in pixels.
    static let maxSide: CGFloat = 1920

    private let folder: URL
    private let queue = DispatchQueue(label: "com.eavesy.swiftaudio.snapshots")
    private var timer: DispatchSourceTimer?
    private var detector = SnapshotDetector()
    private var busy = false
    private var stopped = false
    private var kept = 0

    init(folder: String) {
        self.folder = URL(fileURLWithPath: folder, isDirectory: true)
    }

    /// Starts sampling, unless Screen Recording is off: then it does nothing.
    func start() {
        guard #available(macOS 14.0, *) else { return log("snapshots need macOS 14") }
        guard CGPreflightScreenCaptureAccess() else { return log("Screen Recording is off; no snapshots") }
        do { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
        catch { return log("could not create the snapshots folder: \(error.localizedDescription)") }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + Self.sampleEvery, repeating: Self.sampleEvery, leeway: .milliseconds(250))
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
    }

    func stop() {
        queue.sync {
            stopped = true
            timer?.cancel()
            timer = nil
        }
    }

    private func log(_ message: String) {
        FileHandle.standardError.write(Data("snapshots: \(message)\n".utf8))
    }

    private func tick() {
        // Offsets count from the first audio, as the transcript's do.
        guard !busy, !stopped, let liveAt = captureLiveAt else { return }
        guard #available(macOS 14.0, *) else { return }
        busy = true
        let at = Date().timeIntervalSince(liveAt)
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, error in
            guard let self else { return }
            guard let content, error == nil else {
                self.queue.async { self.busy = false }
                return
            }
            let (filter, source) = self.filter(content)
            guard let filter else {
                self.queue.async { self.busy = false }
                return
            }
            let config = SCStreamConfiguration()
            let scale = CGFloat(filter.pointPixelScale)
            let width = filter.contentRect.width * scale
            let height = filter.contentRect.height * scale
            let shrink = min(1, Self.maxSide / max(width, height, 1))
            config.width = max(1, Int((width * shrink).rounded()))
            config.height = max(1, Int((height * shrink).rounded()))
            config.showsCursor = false
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, _ in
                self.queue.async {
                    defer { self.busy = false }
                    guard let image, !self.stopped else { return }
                    self.consider(image, at: at, source: source)
                }
            }
        }
    }

    @available(macOS 14.0, *)
    private func filter(_ content: SCShareableContent) -> (SCContentFilter?, String) {
        let windows = content.windows
        let candidates = windows.map { window in
            MeetingWindows.Candidate(
                bundle: window.owningApplication?.bundleIdentifier ?? "", title: window.title ?? "",
                width: window.frame.width, height: window.frame.height, onScreen: window.isOnScreen,
                layer: window.windowLayer)
        }
        if let index = MeetingWindows.pick(candidates) {
            return (SCContentFilter(desktopIndependentWindow: windows[index]), "window")
        }
        guard let display = captureDisplay(content) else { return (nil, "display") }
        let excluded = content.applications.filter { $0.bundleIdentifier == "com.eavesy.desktop" }
        return (SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: []), "display")
    }

    private func consider(_ image: CGImage, at: TimeInterval, source: String) {
        guard let features = Self.features(of: image) else { return }
        let decision = detector.consider(features, at: at)
        guard decision == .keep else { return }
        let offsetMs = Int64((at * 1000).rounded())
        let name = SnapshotFiles.name(offsetMs: offsetMs)
        let destination = folder.appendingPathComponent(name)
        let partial = folder.appendingPathComponent(".\(name).partial")
        guard Self.writeJPEG(image, to: partial) else { return log("could not encode a snapshot") }
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: partial, to: destination)
        } catch {
            try? FileManager.default.removeItem(at: partial)
            return log("could not save a snapshot: \(error.localizedDescription)")
        }
        kept += 1
        EventEmitter.emit([
            "event": "snapshot", "path": destination.path, "offsetMs": offsetMs, "width": image.width,
            "height": image.height, "source": source,
        ])
    }

    static func features(of image: CGImage) -> SnapshotFeatures? {
        guard let hash = grey(image, width: SnapshotFeatures.hashWidth, height: SnapshotFeatures.hashHeight, smooth: true),
            let thumb = grey(image, width: SnapshotFeatures.thumbWidth, height: SnapshotFeatures.thumbHeight, smooth: true),
            let flat = grey(image, width: SnapshotFeatures.flatWidth, height: SnapshotFeatures.flatHeight, smooth: false)
        else { return nil }
        return SnapshotFeatures.from(hashPixels: hash, thumbPixels: thumb, flatPixels: flat)
    }

    /// The image squeezed to `width`×`height` greyscale. Without smoothing the
    /// pixels are sampled, so camera noise survives for the flatness measure.
    static func grey(_ image: CGImage, width: Int, height: Int, smooth: Bool) -> [UInt8]? {
        var pixels = [UInt8](repeating: 0, count: width * height)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard
                let context = CGContext(
                    data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
            else { return false }
            context.interpolationQuality = smooth ? .medium : .none
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return drawn ? pixels : nil
    }

    static func writeJPEG(_ image: CGImage, to url: URL) -> Bool {
        guard
            let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { return false }
        CGImageDestinationAddImage(
            destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        return CGImageDestinationFinalize(destination)
    }
}
