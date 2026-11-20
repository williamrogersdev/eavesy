import XCTest
@testable import SwiftAudio

final class PermissionGuideTests: XCTestCase {
    private let card = CGSize(width: 340, height: 160)
    private let visible = CGRect(x: 0, y: 0, width: 1512, height: 944)

    func testKnowsTheDraggablePanesOnly() {
        XCTAssertEqual(PermissionGuide.pane("accessibility")?.name, "Accessibility")
        XCTAssertNotNil(PermissionGuide.pane("screen"))
        XCTAssertNotNil(PermissionGuide.pane("input_monitoring"))
        XCTAssertNil(PermissionGuide.pane("microphone"))
    }

    func testSitsUnderSettingsRightEdgeWhenThereIsRoom() {
        let settings = CGRect(x: 300, y: 400, width: 700, height: 500)
        let origin = PermissionGuide.origin(card: card, settings: settings, visible: visible)
        XCTAssertEqual(origin.x, settings.maxX - card.width)
        XCTAssertEqual(origin.y, settings.minY - 12 - card.height)
    }

    func testGoesBesideSettingsWhenItReachesTheBottom() {
        let settings = CGRect(x: 100, y: 40, width: 700, height: 860)
        let origin = PermissionGuide.origin(card: card, settings: settings, visible: visible)
        XCTAssertEqual(origin, CGPoint(x: settings.maxX + 12, y: settings.minY))
    }

    func testFallsInsideTheCornerWhenSettingsFillsTheScreen() {
        let settings = visible
        let origin = PermissionGuide.origin(card: card, settings: settings, visible: visible)
        XCTAssertEqual(origin, CGPoint(x: visible.maxX - card.width - 12, y: visible.minY + 12))
    }

    func testStaysOnScreenBesideANarrowSettingsWindowAtTheLeftEdge() {
        let settings = CGRect(x: 0, y: 0, width: 250, height: 944)
        let narrowVisible = CGRect(x: 0, y: 0, width: 600, height: 944)
        let origin = PermissionGuide.origin(card: card, settings: settings, visible: narrowVisible)
        XCTAssertEqual(origin, CGPoint(x: 12, y: 12))
    }

    func testConvertsCoreGraphicsBoundsToCocoa() {
        let rect = PermissionGuide.cocoaRect(fromCG: CGRect(x: 10, y: 20, width: 100, height: 50), mainScreenHeight: 1000)
        XCTAssertEqual(rect, CGRect(x: 10, y: 930, width: 100, height: 50))
    }
}
