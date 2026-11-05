import CoreGraphics
import XCTest
@testable import SwiftAudio

final class SnapshotSamplerTests: XCTestCase {
    /// A slide: a flat background, a title bar and `bullets` lines of "text".
    func slide(bullets: Int, background: CGFloat = 1, width: Int = 1280, height: Int = 720) -> CGImage {
        let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red: background, green: background, blue: background, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(red: 0.1, green: 0.2, blue: 0.5, alpha: 1))
        context.fill(CGRect(x: 80, y: height - 160, width: width - 160, height: 80))
        context.setFillColor(CGColor(red: 0.15, green: 0.15, blue: 0.15, alpha: 1))
        for line in 0..<bullets {
            let y = height - 240 - line * 70
            context.fill(CGRect(x: 120, y: y, width: 40, height: 40))
            context.fill(CGRect(x: 200, y: y + 8, width: 600 + (line % 3) * 120, height: 24))
        }
        return context.makeImage()!
    }

    /// Camera video: every pixel a little different from its neighbour.
    func camera(seed: UInt64, width: Int = 1280, height: Int = 720) -> CGImage {
        var state = seed
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for i in stride(from: 0, to: pixels.count, by: 4) {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            let base = UInt8((i / 4) % width * 200 / width)
            let noise = UInt8(truncatingIfNeeded: state >> 59)
            pixels[i] = base &+ noise
            pixels[i + 1] = base / 2 &+ noise
            pixels[i + 2] = 90 &+ noise
            pixels[i + 3] = 255
        }
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    }

    func features(_ image: CGImage) throws -> SnapshotFeatures {
        try XCTUnwrap(SnapshotSampler.features(of: image))
    }

    func testASlideIsKeptOnceItHasSettled() throws {
        var detector = SnapshotDetector()
        let first = try features(slide(bullets: 2))
        XCTAssertEqual(detector.consider(first, at: 2.5), .moving, "nothing to compare with yet")
        XCTAssertEqual(detector.consider(first, at: 5), .keep)
        XCTAssertEqual(detector.consider(first, at: 7.5), .unchanged)
        XCTAssertEqual(detector.consider(first, at: 60), .unchanged, "the same slide is never kept twice")
    }

    func testANewSlideIsKeptButNotTooSoon() throws {
        var detector = SnapshotDetector()
        let one = try features(slide(bullets: 1))
        let three = try features(slide(bullets: 4))
        let other = try features(camera(seed: 3))
        XCTAssertGreaterThan(three.changed(from: one), detector.changedFrom)
        _ = detector.consider(one, at: 0)
        XCTAssertEqual(detector.consider(one, at: 2.5), .keep)
        XCTAssertEqual(detector.consider(three, at: 5), .tooSoon)
        XCTAssertEqual(detector.consider(three, at: 7.5), .tooSoon)
        XCTAssertEqual(detector.consider(three, at: 10.5), .keep, "asked again once the interval passed")
        XCTAssertEqual(detector.consider(other, at: 30), .moving, "a cut to something else has to settle first")
    }

    func testCameraVideoIsNotShared() throws {
        let still = try features(camera(seed: 7))
        XCTAssertLessThan(still.flatRatio, SnapshotDetector().minFlatRatio)
        XCTAssertGreaterThan(try features(slide(bullets: 3)).flatRatio, 0.8)
        var detector = SnapshotDetector()
        _ = detector.consider(still, at: 0)
        XCTAssertEqual(detector.consider(still, at: 2.5), .camera, "even a camera grid that holds still")
    }

    func testASpeakerTileOverAShareDoesNotUnsettleItOrCountAsANewSlide() throws {
        let share = slide(bullets: 3, width: 1920, height: 1080)
        func withTile(_ seed: UInt64) throws -> SnapshotFeatures {
            let context = CGContext(
                data: nil, width: 1920, height: 1080, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(share, in: CGRect(x: 0, y: 0, width: 1920, height: 1080))
            context.draw(camera(seed: seed, width: 240, height: 135), in: CGRect(x: 1660, y: 925, width: 240, height: 135))
            return try features(context.makeImage()!)
        }
        var detector = SnapshotDetector()
        _ = detector.consider(try withTile(1), at: 0)
        XCTAssertEqual(detector.consider(try withTile(2), at: 2.5), .keep)
        XCTAssertEqual(detector.consider(try withTile(3), at: 20), .unchanged)
    }

    func testMovingVideoNeverSettles() throws {
        var detector = SnapshotDetector()
        let a = SnapshotFeatures(hash: [0, 0, 0, 0], thumb: [0], flatRatio: 0.9, contrast: 50)
        let b = SnapshotFeatures(hash: [.max, 0, 0, 0], thumb: [0], flatRatio: 0.9, contrast: 50)
        XCTAssertEqual(detector.consider(a, at: 0), .moving)
        XCTAssertEqual(detector.consider(b, at: 2.5), .moving)
        XCTAssertEqual(detector.consider(a, at: 5), .moving)
    }

    func testABlankShareIsSkipped() throws {
        let black = try features(slide(bullets: 0, background: 0))
        var detector = SnapshotDetector()
        let blank = SnapshotFeatures(hash: black.hash, thumb: black.thumb, flatRatio: 1, contrast: 0)
        _ = detector.consider(blank, at: 0)
        XCTAssertEqual(detector.consider(blank, at: 2.5), .blank)
    }

    func testFilesAreNamedByTheirOffset() {
        XCTAssertEqual(SnapshotFiles.name(offsetMs: 123_456), "snapshot-000123456.jpg")
        XCTAssertEqual(SnapshotFiles.name(offsetMs: -5), "snapshot-000000000.jpg")
        XCTAssertEqual(SnapshotFiles.name(offsetMs: 12_345_678_901), "snapshot-12345678901.jpg")
    }

    func testTheLargestMeetingWindowIsPicked() {
        func window(_ bundle: String, _ title: String = "", _ width: CGFloat = 1200, _ height: CGFloat = 800, layer: Int = 0)
            -> MeetingWindows.Candidate
        {
            .init(bundle: bundle, title: title, width: width, height: height, onScreen: true, layer: layer)
        }
        let windows = [
            window("com.apple.Terminal"),
            window("us.zoom.xos", "Zoom Meeting", 900, 600),
            window("us.zoom.xos", "Zoom Share", 1600, 1000),
            window("us.zoom.xos", "toolbar", 2000, 60),
            window("com.google.Chrome", "Meet - abc-defg-hij", 2000, 1200),
        ]
        XCTAssertEqual(MeetingWindows.pick(windows), 2, "a meeting app wins over a browser")
        XCTAssertEqual(MeetingWindows.pick(Array(windows[4...]) + [window("com.google.Chrome", "Docs")]), 0)
        XCTAssertNil(MeetingWindows.pick([window("com.google.Chrome", "Docs"), window("us.zoom.xos", layer: 3)]))
    }

    func testOnlyAudioCapturesTakeASnapshotsFolder() {
        let audio = Arguments.parse(["x", "--mode", "audio", "--out", "/a.m4a", "--source", "mixed", "--snapshots-dir", "/s"])
        XCTAssertEqual(audio.snapshotsDir, "/s")
        XCTAssertNil(Arguments.parse(["x", "--mode", "audio", "--out", "/a.m4a", "--source", "mixed"]).snapshotsDir)
        XCTAssertNil(Arguments.parse(["x", "--mode", "screen", "--out", "/a.mp4", "--snapshots-dir", "/s"]).snapshotsDir)
    }
}
