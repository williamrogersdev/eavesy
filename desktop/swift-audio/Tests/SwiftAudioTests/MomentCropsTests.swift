import CoreGraphics
import XCTest
@testable import SwiftAudio

final class MomentCropsTests: XCTestCase {
    let frame = CGRect(x: 0, y: 0, width: 1920, height: 1080)

    func testACloseUpKeepsRoomAroundWhatWasPointedAt() {
        let focus = CGRect(x: 800, y: 400, width: 114, height: 36)
        let crop = MomentCrops.cropRect(around: focus, minimum: MomentCrops.minimum, padding: MomentCrops.padding, in: frame)
        XCTAssertTrue(crop.contains(focus))
        XCTAssertGreaterThanOrEqual(crop.width, MomentCrops.minimum.width)
        XCTAssertGreaterThanOrEqual(crop.height, MomentCrops.minimum.height)
        XCTAssertEqual(crop.midX, focus.midX, accuracy: 1)
    }

    func testACloseUpAtTheEdgeMovesInsideTheFrame() {
        let focus = CGRect(x: 1900, y: 1070, width: 10, height: 6)
        let crop = MomentCrops.cropRect(around: focus, minimum: MomentCrops.minimum, padding: MomentCrops.padding, in: frame)
        XCTAssertEqual(crop.maxX, frame.maxX)
        XCTAssertEqual(crop.maxY, frame.maxY)
        XCTAssertTrue(crop.contains(focus))
    }

    func testAClickWithoutAnElementIsASmallSquareAtThePointer() throws {
        let moment = MomentCrops.Moment(number: 1, kind: "click", timestampMs: 0, point: .init(x: 100, y: 50), rect: nil)
        XCTAssertEqual(try XCTUnwrap(MomentCrops.focusRect(moment)), CGRect(x: 88, y: 38, width: 24, height: 24))
        let area = MomentCrops.Moment(number: 2, kind: "area", timestampMs: 0, point: nil, rect: .init(x: 1, y: 2, width: 3, height: 4))
        XCTAssertEqual(MomentCrops.focusRect(area), CGRect(x: 1, y: 2, width: 3, height: 4))
    }

    func testAnAreaClipsTheExactSelectedPixelsOnRetina() {
        let selected = CGRect(x: 200, y: 120, width: 280, height: 200)
        let target = MomentCrops.inFrame(selected, display: CGRect(x: 0, y: 0, width: 960, height: 540), frameWidth: 1920)
        XCTAssertEqual(MomentCrops.clipRect(kind: "area", target: target, scale: 2, in: frame),
                       CGRect(x: 400, y: 240, width: 560, height: 400))
        XCTAssertTrue(MomentCrops.clipRect(kind: "element", target: target, scale: 2, in: frame).contains(target))
    }

    func testAnAreaClipAtTheDisplayEdgeStaysInsideTheVideo() {
        XCTAssertEqual(MomentCrops.clipRect(kind: "area", target: CGRect(x: 1880, y: 1040, width: 80, height: 80), scale: 1, in: frame),
                       CGRect(x: 1880, y: 1040, width: 40, height: 40))
    }

    func testASecondDisplaysOriginIsTakenOff() {
        let display = CGRect(x: 1512, y: -200, width: 1920, height: 1080)
        let focus = CGRect(x: 1612, y: -100, width: 50, height: 20)
        XCTAssertEqual(MomentCrops.inFrame(focus, display: display, frameWidth: 3840), CGRect(x: 200, y: 200, width: 100, height: 40))
    }

    func testTheMomentsFileFromTheAppDecodes() throws {
        let json = #"{"schemaVersion":1,"display":{"x":0,"y":0,"width":1512,"height":982},"moments":[{"number":1,"kind":"element","mark":1,"timestampMs":4200,"point":{"x":10,"y":20},"rect":{"x":5,"y":6,"width":70,"height":20},"element":{"role":"AXButton"},"place":{"app":"Safari"}}]}"#
        let input = try JSONDecoder().decode(MomentCrops.Input.self, from: Data(json.utf8))
        XCTAssertEqual(input.display.width, 1512)
        XCTAssertEqual(input.moments.first?.rect?.rect, CGRect(x: 5, y: 6, width: 70, height: 20))
    }
}
