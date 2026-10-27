import XCTest
@testable import SwiftAudio

final class PreflightTests: XCTestCase {
    func testDefaultPreflightAsksForTheMicrophoneOnly() {
        XCTAssertEqual(Preflight.prompts(["SwiftAudio", "--preflight"]), [.mic])
    }

    func testNeedFlagsAddScreenAndSpeech() {
        XCTAssertEqual(
            Preflight.prompts(["SwiftAudio", "--preflight", "--need-screen", "--need-speech"]),
            [.mic, .screen, .speech])
    }

    func testRequestAsksForExactlyOnePermission() {
        XCTAssertEqual(Preflight.prompts(["SwiftAudio", "--preflight", "--request", "speech"]), [.speech])
        XCTAssertEqual(Preflight.prompts(["SwiftAudio", "--preflight", "--request", "screen", "--need-speech"]), [.screen])
        XCTAssertEqual(Preflight.prompts(["SwiftAudio", "--preflight", "--request", "camera"]), [])
        XCTAssertEqual(Preflight.prompts(["SwiftAudio", "--preflight", "--request"]), [])
    }

    func testNoPromptWins() {
        XCTAssertEqual(Preflight.prompts(["SwiftAudio", "--preflight", "--no-prompt", "--request", "mic"]), [])
    }
}
