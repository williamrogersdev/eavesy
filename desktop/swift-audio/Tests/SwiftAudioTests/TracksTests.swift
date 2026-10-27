import XCTest
@testable import SwiftAudio

final class TracksTests: XCTestCase {
    func testShortMicPullIsPaddedToSystemLength() {
        let chunk = splitChunk(system: [0.1, 0.2, 0.3], mic: [0.5])
        XCTAssertEqual(chunk.mic, [0.5, 0, 0])
        XCTAssertEqual(chunk.system, [0.1, 0.2, 0.3])
        XCTAssertEqual(chunk.mix.count, 3)
        XCTAssertEqual(chunk.mix[0], 0.6, accuracy: 1e-6)
    }

    func testTracksStayIndependentOfTheMix() {
        let chunk = splitChunk(system: [0.9], mic: [0.9])
        XCTAssertEqual(chunk.mix, [1.0])
        XCTAssertEqual(chunk.mic, [0.9])
        XCTAssertEqual(chunk.system, [0.9])
    }

    func testSilenceHasNoActiveTime() {
        var level = TrackLevel()
        level.observe([Float](repeating: 0.0005, count: 48_000))
        XCTAssertEqual(level.activeMs, 0)
        XCTAssertLessThan(level.peakRms, TrackLevel.activeThreshold)
    }

    func testSpeechLevelCountsAcrossBufferBoundaries() {
        var level = TrackLevel()
        let second = (0..<48_000).map { i -> Float in i % 2 == 0 ? 0.1 : -0.1 }
        var offset = 0
        while offset < second.count {
            let end = min(offset + 1_000, second.count)
            level.observe(Array(second[offset..<end]))
            offset = end
        }
        XCTAssertEqual(level.activeMs, 33 * 30)
        XCTAssertEqual(level.peakRms, 0.1, accuracy: 1e-6)
    }

    func testQuietSpeechStillCountsAsActive() {
        var level = TrackLevel()
        level.observe([Float](repeating: 0.006, count: 48_000))
        XCTAssertEqual(level.activeMs, 33 * 30)
    }
}
