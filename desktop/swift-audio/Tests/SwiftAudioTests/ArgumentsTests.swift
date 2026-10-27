import XCTest
@testable import SwiftAudio

final class ArgumentsTests: XCTestCase {
    private func parse(_ extra: [String]) -> Arguments {
        Arguments.parse(["SwiftAudio", "--mode", "audio", "--out", "/tmp/a.m4a", "--source", "mixed"] + extra)
    }

    func testMicrophoneDefaultsDependOnMode() {
        XCTAssertFalse(parse([]).includeMic)
        XCTAssertTrue(parse(["--mic"]).includeMic)
        XCTAssertFalse(parse(["--mic", "false"]).includeMic)
        let screen = ["SwiftAudio", "--mode", "screen", "--out", "/tmp/video.mp4"]
        XCTAssertTrue(Arguments.parse(screen).includeMic)
        XCTAssertFalse(Arguments.parse(screen + ["--mic", "false"]).includeMic)
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

    func testVocabularyIsOneWordOrPhrasePerLine() {
        XCTAssertEqual(parse([]).vocabulary, [])
        XCTAssertEqual(parse(["--vocabulary", "Eavesy\n Priya Raman \n\nKubernetes"]).vocabulary, ["Eavesy", "Priya Raman", "Kubernetes"])
    }

    func testTheLivePreviewIsOnUnlessTurnedOff() {
        XCTAssertTrue(parse([]).preview)
        XCTAssertFalse(parse(["--no-preview"]).preview)
        XCTAssertFalse(parse(["--no-preview", "--vocabulary", "Eavesy"]).preview)
    }

    func testVocabularyIsCapped() {
        let many = (0..<150).map { "word\($0)" }.joined(separator: "\n")
        XCTAssertEqual(parse(["--vocabulary", many]).vocabulary.count, 100)
        XCTAssertEqual(parse(["--vocabulary", String(repeating: "x", count: 200)]).vocabulary.first?.count, 60)
    }
}
