import XCTest
@testable import SwiftAudio

final class StandbyTests: XCTestCase {
    /// Hands out `chunks` one read at a time, then end of input.
    private func reader(_ chunks: [String]) -> LineReader {
        var rest = chunks.map { Data($0.utf8) }
        return LineReader { rest.isEmpty ? Data() : rest.removeFirst() }
    }

    func testLinesSplitAcrossReadsAreJoined() {
        let lines = reader(["st", "op\n  next \n", "tail"])
        XCTAssertEqual(lines.next(), "stop")
        XCTAssertEqual(lines.next(), "next")
        XCTAssertNil(lines.next(), "an unterminated last line is not a command")
    }

    func testTheStartLineCarriesTheColdLaunchArguments() {
        let argv = Standby.startArguments(#"{"start":["--mode","audio","--out","/tmp/a \"b\".m4a"]}"#)
        XCTAssertEqual(argv, ["--mode", "audio", "--out", "/tmp/a \"b\".m4a"])
        XCTAssertNil(Standby.startArguments("stop"))
        XCTAssertNil(Standby.startArguments(#"{"start":"--mode audio"}"#))
    }

    func testAStopSentRightAfterTheStartIsKeptForTheCapture() {
        let lines = reader([#"{"start":["--mode","audio"]}"# + "\nstop\n"])
        XCTAssertEqual(Standby.awaitStart(lines), ["--mode", "audio"])
        XCTAssertEqual(lines.next(), "stop")
    }

    func testAStandbyWhoseHostLeavesNeverStarts() {
        XCTAssertNil(Standby.awaitStart(reader(["garbage\n"])))
        XCTAssertNil(Standby.awaitStart(reader(["stop\n", #"{"start":[]}"# + "\n"])))
    }

    func testTheStartedArgumentsParseAsACaptureWould() {
        let argv = Standby.startArguments(
            #"{"start":["--mode","audio","--out","/tmp/a.m4a","--source","mic","--captions","mic"]}"#)!
        let args = Arguments.parse(["SwiftAudio"] + argv)
        XCTAssertEqual(args.source, .mic)
        XCTAssertEqual(args.captions, [.mic])
    }
}
