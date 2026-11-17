import CoreMedia
import XCTest
@testable import SwiftAudio

final class PauseTimelineTests: XCTestCase {
    private func t(_ seconds: Double) -> CMTime { CMTime(seconds: seconds, preferredTimescale: 600) }
    private func placed(_ line: PauseTimeline, _ seconds: Double, duration: Double = 0) -> Double? {
        line.placed(t(seconds), duration: t(duration)).map(CMTimeGetSeconds)
    }

    func testNothingMovesBeforeAnyPause() {
        let line = PauseTimeline()
        XCTAssertFalse(line.isPaused)
        XCTAssertEqual(placed(line, 3.5), 3.5)
    }

    func testSamplesDuringAPauseAreLeftOutAndLaterOnesCloseTheGap() {
        var line = PauseTimeline()
        XCTAssertTrue(line.pause(at: t(10)))
        XCTAssertTrue(line.isPaused)
        // Captured before the pause, delivered after it began: still kept.
        XCTAssertEqual(placed(line, 9.9), 9.9)
        XCTAssertNil(placed(line, 10))
        XCTAssertNil(placed(line, 500))
        XCTAssertTrue(line.resume(at: t(25)))
        XCTAssertNil(placed(line, 24.99), "captured during the pause, delivered after the resume")
        XCTAssertEqual(placed(line, 25)!, 10, accuracy: 0.001)
        XCTAssertEqual(placed(line, 31)!, 16, accuracy: 0.001)
        XCTAssertEqual(placed(line, 4), 4)
    }

    func testPausesAddUp() {
        var line = PauseTimeline()
        _ = line.pause(at: t(10)); _ = line.resume(at: t(20))
        _ = line.pause(at: t(30)); _ = line.resume(at: t(35))
        XCTAssertEqual(placed(line, 25)!, 15, accuracy: 0.001)
        XCTAssertNil(placed(line, 32))
        XCTAssertEqual(placed(line, 40)!, 25, accuracy: 0.001)
    }

    func testASampleThatRunsIntoAPauseIsLeftOutWhole() {
        var line = PauseTimeline()
        _ = line.pause(at: t(10))
        XCTAssertNil(placed(line, 9.99, duration: 0.02))
        XCTAssertEqual(placed(line, 9.98, duration: 0.02)!, 9.98, accuracy: 0.001)
        _ = line.resume(at: t(20))
        XCTAssertNil(placed(line, 9.99, duration: 0.02))
        XCTAssertNil(placed(line, 19.99, duration: 0.02))
        XCTAssertEqual(placed(line, 20, duration: 0.02)!, 10, accuracy: 0.001)
    }

    func testRepeatedCommandsAreIgnored() {
        var line = PauseTimeline()
        XCTAssertFalse(line.resume(at: t(1)))
        XCTAssertTrue(line.pause(at: t(2)))
        XCTAssertFalse(line.pause(at: t(3)))
        XCTAssertTrue(line.resume(at: t(4)))
        XCTAssertEqual(placed(line, 5)!, 3, accuracy: 0.001)
    }

    func testAPauseNeverStartsBeforeTheLastResume() {
        var line = PauseTimeline()
        _ = line.pause(at: t(10)); _ = line.resume(at: t(20))
        _ = line.pause(at: t(15)); _ = line.resume(at: t(22))
        XCTAssertEqual(placed(line, 30)!, 18, accuracy: 0.001)
    }
}
