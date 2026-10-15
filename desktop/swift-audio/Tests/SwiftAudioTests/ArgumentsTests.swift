import XCTest
@testable import SwiftAudio

final class ArgumentsTests: XCTestCase {
    private func parse(_ extra: [String]) -> Arguments {
        Arguments.parse(["SwiftAudio", "--mode", "audio", "--out", "/tmp/a.m4a", "--source", "mixed"] + extra)
    }

    func testSegmentsDefaultToOneMinute() {
        XCTAssertEqual(parse([]).segmentSec, 60)
    }

    func testSegmentLengthKeepsItsThirtySecondFloor() {
        XCTAssertEqual(parse(["--segment-sec", "5"]).segmentSec, 30)
        XCTAssertEqual(parse(["--segment-sec", "240"]).segmentSec, 240)
    }

    func testHardCapScalesWithTheTarget() {
        XCTAssertEqual(hardCapSec(forSegmentSec: 30), 45)
        XCTAssertEqual(hardCapSec(forSegmentSec: 60), 90)
        XCTAssertEqual(hardCapSec(forSegmentSec: 240), 300)
    }
}
