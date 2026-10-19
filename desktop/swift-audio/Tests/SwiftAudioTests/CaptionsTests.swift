import AVFoundation
import XCTest
@testable import SwiftAudio

private struct EngineBroke: Error {}

/// Records what the captions layer asks of it; can be told to throw.
private final class FakeEngine: SpeechEngine {
    let name = "fake"
    var failOnStart = false
    var failOnAppend = 0
    private(set) var appended: [Int64] = []
    private(set) var finished = false
    weak var sink: CaptionSink?

    func start(sink: CaptionSink) throws {
        if failOnStart { throw EngineBroke() }
        self.sink = sink
    }

    func append(_ buffer: AVAudioPCMBuffer, atMs: Int64) throws {
        appended.append(atMs)
        if appended.count == failOnAppend { throw EngineBroke() }
    }

    func finish(_ done: @escaping () -> Void) {
        finished = true
        sink?.recognized(text: " last words ", isFinal: true, startMs: 900, endMs: 1_400)
        done()
    }
}

private final class Events {
    private let lock = NSLock()
    private var all: [[String: Any]] = []
    func emit(_ event: [String: Any]) {
        lock.lock()
        all.append(event)
        lock.unlock()
    }
    var list: [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return all
    }
    func named(_ name: String) -> [[String: Any]] { list.filter { $0["event"] as? String == name } }
}

final class CaptionsTests: XCTestCase {
    private let samples = [Float](repeating: 0.1, count: 480)

    func testCaptionEventEncodesAsOneProtocolLine() throws {
        let event = CaptionEvent(track: "mic", text: "hello \"world\"", isFinal: true, startMs: 1_200, endMs: 2_050)
        let line = try XCTUnwrap(EventEmitter.line(event.json))
        XCTAssertEqual(line.last, 0x0A)
        XCTAssertEqual(
            String(decoding: line, as: UTF8.self),
            #"{"endMs":2050,"event":"caption","final":true,"startMs":1200,"text":"hello \"world\"","track":"mic"}"#
                + "\n")
    }

    func testStatusEventsEncode() throws {
        let live = try XCTUnwrap(EventEmitter.line(CaptionStatus.live(engine: "sfspeech").json(track: "system")))
        XCTAssertEqual(
            String(decoding: live, as: UTF8.self),
            #"{"engine":"sfspeech","event":"captions_status","status":"live","track":"system"}"# + "\n")
        let off = try XCTUnwrap(
            EventEmitter.line(CaptionStatus.unavailable(reason: "denied").json(track: "mic")))
        XCTAssertEqual(
            String(decoding: off, as: UTF8.self),
            #"{"event":"captions_status","reason":"denied","status":"unavailable","track":"mic"}"# + "\n")
    }

    func testAudioFedBeforeTheEngineIsReadyIsHeldThenDelivered() {
        let events = Events()
        let engine = FakeEngine()
        var ready: ((Result<SpeechEngine, CaptionUnavailable>) -> Void)?
        let captions = LiveCaptions(track: "mic", emit: events.emit) { ready = $0 }
        captions.feed(samples, atMs: 0)
        captions.feed(samples, atMs: 10)
        ready?(.success(engine))
        captions.feed(samples, atMs: 20)
        captions.finish(timeout: 1)
        XCTAssertEqual(engine.appended, [0, 10, 20])
        XCTAssertTrue(engine.finished)
        XCTAssertEqual(events.named("captions_status").first?["status"] as? String, "live")
        let finals = events.named("caption")
        XCTAssertEqual(finals.count, 1)
        XCTAssertEqual(finals.first?["text"] as? String, "last words")
        XCTAssertEqual(finals.first?["final"] as? Bool, true)
    }

    func testAnEngineThatThrowsTurnsCaptionsOffOnceAndStopsFeeding() {
        let events = Events()
        let engine = FakeEngine()
        engine.failOnAppend = 2
        let captions = LiveCaptions(track: "mic", emit: events.emit) { $0(.success(engine)) }
        for ms in stride(from: Int64(0), to: 100, by: 10) {
            captions.feed(samples, atMs: ms)
        }
        captions.finish(timeout: 1)
        XCTAssertEqual(engine.appended.count, 2, "nothing reaches a failed engine")
        XCTAssertFalse(engine.finished, "a failed engine is not asked to finish")
        let statuses = events.named("captions_status").compactMap { $0["status"] as? String }
        XCTAssertEqual(statuses, ["live", "unavailable"])
    }

    func testAnEngineThatCannotStartReportsUnavailable() {
        let events = Events()
        let engine = FakeEngine()
        engine.failOnStart = true
        let captions = LiveCaptions(track: "system", emit: events.emit) { $0(.success(engine)) }
        captions.feed(samples, atMs: 0)
        captions.finish(timeout: 1)
        XCTAssertTrue(engine.appended.isEmpty)
        XCTAssertEqual(events.named("captions_status").first?["status"] as? String, "unavailable")
    }

    func testNoEngineMeansUnavailableAndFinishReturnsAtOnce() {
        let events = Events()
        let captions = LiveCaptions(track: "mic", emit: events.emit) {
            $0(.failure(CaptionUnavailable(reason: "locale unsupported")))
        }
        captions.feed(samples, atMs: 0)
        let started = Date()
        captions.finish(timeout: 5)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
        XCTAssertEqual(events.named("captions_status").first?["reason"] as? String, "locale unsupported")
        XCTAssertTrue(events.named("caption").isEmpty)
    }

    func testAnEngineThatNeverFinishesCannotHoldUpStop() {
        final class Stuck: SpeechEngine {
            let name = "stuck"
            func start(sink: CaptionSink) throws {}
            func append(_ buffer: AVAudioPCMBuffer, atMs: Int64) throws {}
            func finish(_ done: @escaping () -> Void) {}
        }
        let captions = LiveCaptions(track: "mic", emit: { _ in }) { $0(.success(Stuck())) }
        captions.feed(samples, atMs: 0)
        let started = Date()
        captions.finish(timeout: 0.3)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
    }

    func testEngineFailureReportedLaterStopsCaptions() {
        let events = Events()
        let engine = FakeEngine()
        let captions = LiveCaptions(track: "mic", emit: events.emit) { $0(.success(engine)) }
        captions.feed(samples, atMs: 0)
        let deadline = Date().addingTimeInterval(1)
        while engine.appended.isEmpty, Date() < deadline { usleep(1_000) }
        XCTAssertNotNil(engine.sink)
        engine.sink?.engineFailed("model crashed")
        let expectation = expectation(description: "off")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { expectation.fulfill() }
        wait(for: [expectation], timeout: 1)
        engine.sink?.recognized(text: "ignored", isFinal: true, startMs: 0, endMs: 1)
        XCTAssertFalse(events.named("caption").contains { $0["text"] as? String == "ignored" })
    }

    func testCaptionsFollowTheRecordedTracks() {
        XCTAssertEqual(Arguments.parseCaptions("mic", source: .mic), [.mic])
        XCTAssertEqual(Arguments.parseCaptions("all", source: .mixed), [.mic, .system])
        XCTAssertEqual(Arguments.parseCaptions("mic", source: .system), [])
        XCTAssertEqual(Arguments.parseCaptions(nil, source: .mixed), [])
    }

    func testCaptionLocaleKeepsTheRegionalVariantOfTheCloudLanguage() {
        let gb = Locale(identifier: "en_GB")
        let supported = ["en-US", "en-GB", "fr-FR", "fr-CA", "es-ES", "es-MX"].map(Locale.init(identifier:))
        XCTAssertEqual(Arguments.captionLocale(language: "en", current: gb, supported: supported).identifier, "en_GB")
        XCTAssertEqual(
            Arguments.captionLocale(language: "en", current: Locale(identifier: "fr_FR"), supported: supported)
                .identifier, "en-US")
        XCTAssertEqual(
            Arguments.captionLocale(language: "es", current: Locale(identifier: "en_MX"), supported: supported)
                .identifier, "es-MX")
        XCTAssertEqual(Arguments.captionLocale(language: nil, current: gb, supported: supported).identifier, "en_GB")
        XCTAssertEqual(Arguments.captionLocale(language: "auto", current: gb, supported: supported).identifier, "en_GB")
        XCTAssertEqual(
            Arguments.captionLocale(language: "sw", current: gb, supported: supported).identifier, "en_GB",
            "a language no recognizer here speaks keeps the system's")
        XCTAssertEqual(
            Arguments.captionLocale(language: "en", current: Locale(identifier: "fr_FR"), supported: []).identifier, "en")
    }

    func testSupportedLocalesAreOnlyAskedForWhenNeeded() {
        var asked = 0
        func supported() -> [Locale] {
            asked += 1
            return [Locale(identifier: "es-ES")]
        }
        let us = Locale(identifier: "en_US")
        _ = Arguments.captionLocale(language: "en", current: us, supported: supported())
        _ = Arguments.captionLocale(language: "auto", current: us, supported: supported())
        _ = Arguments.captionLocale(language: nil, current: us, supported: supported())
        XCTAssertEqual(asked, 0)
        XCTAssertEqual(Arguments.captionLocale(language: "es", current: us, supported: supported()).identifier, "es-ES")
        XCTAssertEqual(asked, 1)
    }

    func testAutoLanguageFollowsSpeechAndAFixedOneDoesNot() {
        let base = ["SwiftAudio", "--mode", "audio", "--out", "/tmp/a.m4a", "--source", "mic"]
        XCTAssertTrue(Arguments.parse(base + ["--language", "auto"]).followsSpeech)
        XCTAssertFalse(Arguments.parse(base + ["--language", "es"]).followsSpeech)
        XCTAssertFalse(Arguments.parse(base).followsSpeech)
    }

    func testSwitchingEnginesHandsOverWithoutLosingAudio() {
        let events = Events()
        let first = FakeEngine()
        let second = FakeEngine()
        let captions = LiveCaptions(track: "mic", emit: events.emit) { $0(.success(first)) }
        captions.feed(samples, atMs: 0)
        captions.feed(samples, atMs: 10)
        var outcomes: [EngineSwitch] = []
        captions.switchEngine({ $0(.success(second)) }, outcome: { outcomes.append($0) })
        captions.feed(samples, atMs: 20)
        captions.feed(samples, atMs: 30)
        captions.finish(timeout: 1)
        XCTAssertEqual(first.appended, [0, 10])
        XCTAssertEqual(second.appended, [20, 30])
        XCTAssertTrue(first.finished, "the replaced engine settles its last finals")
        XCTAssertTrue(second.finished)
        XCTAssertEqual(outcomes, [.switched])
        XCTAssertEqual(events.named("caption").count, 2, "both engines' last words are kept")
        XCTAssertEqual(events.named("captions_status").compactMap { $0["status"] as? String }, ["live", "live"])
        XCTAssertEqual(events.named("captions_done").first?["failed"] as? Bool, false)
    }

    func testAFailedSwitchKeepsTheEngineCaptionsHave() {
        let events = Events()
        let first = FakeEngine()
        let captions = LiveCaptions(track: "mic", emit: events.emit) { $0(.success(first)) }
        captions.feed(samples, atMs: 0)
        let reported = expectation(description: "unavailable")
        captions.switchEngine({ $0(.failure(CaptionUnavailable(reason: "no model for es-ES"))) }, outcome: {
            XCTAssertEqual($0, .unavailable("no model for es-ES"))
            reported.fulfill()
        })
        wait(for: [reported], timeout: 1)
        captions.feed(samples, atMs: 10)
        captions.finish(timeout: 1)
        XCTAssertEqual(first.appended, [0, 10])
        XCTAssertEqual(events.named("captions_status").compactMap { $0["status"] as? String }, ["live"])
    }

    func testAReplacedEngineFailingWhileItSettlesLeavesCaptionsOn() {
        let events = Events()
        let first = FakeEngine()
        let second = FakeEngine()
        let captions = LiveCaptions(track: "mic", emit: events.emit) { $0(.success(first)) }
        captions.feed(samples, atMs: 0)
        captions.switchEngine({ $0(.success(second)) }, outcome: { _ in })
        captions.feed(samples, atMs: 10)
        let deadline = Date().addingTimeInterval(1)
        while second.appended.isEmpty, Date() < deadline { usleep(1_000) }
        first.sink?.engineFailed("cancelled")
        captions.feed(samples, atMs: 20)
        captions.finish(timeout: 1)
        XCTAssertEqual(second.appended, [10, 20])
        XCTAssertFalse(events.named("captions_status").contains { $0["status"] as? String == "unavailable" })
    }

    func testASwitchBeforeTheFirstEngineIsReadyTakesItsPlace() {
        let events = Events()
        let first = FakeEngine()
        let second = FakeEngine()
        var ready: ((Result<SpeechEngine, CaptionUnavailable>) -> Void)?
        let captions = LiveCaptions(track: "mic", emit: events.emit) { ready = $0 }
        captions.feed(samples, atMs: 0)
        let switched = expectation(description: "switched")
        captions.switchEngine({ $0(.success(second)) }, outcome: {
            XCTAssertEqual($0, .switched, "an engine still starting is not a reason to give up on the language")
            switched.fulfill()
        })
        wait(for: [switched], timeout: 1)
        ready?(.success(first))
        captions.feed(samples, atMs: 10)
        captions.finish(timeout: 1)
        XCTAssertEqual(second.appended, [0, 10], "the held audio goes to the engine that won")
        XCTAssertTrue(first.appended.isEmpty)
        XCTAssertTrue(first.finished, "the engine that lost is let go of")
        XCTAssertEqual(events.named("captions_status").compactMap { $0["status"] as? String }, ["live"])
    }

    func testASwitchStillStartingOutlivesAFirstEngineThatFailed() {
        let events = Events()
        let second = FakeEngine()
        var ready: ((Result<SpeechEngine, CaptionUnavailable>) -> Void)?
        var answerSwitch: ((Result<SpeechEngine, CaptionUnavailable>) -> Void)?
        let captions = LiveCaptions(track: "mic", emit: events.emit) { ready = $0 }
        captions.feed(samples, atMs: 0)
        let switched = expectation(description: "switched")
        captions.switchEngine({ answerSwitch = $0 }, outcome: {
            XCTAssertEqual($0, .switched)
            switched.fulfill()
        })
        ready?(.failure(CaptionUnavailable(reason: "no model for en-US")))
        answerSwitch?(.success(second))
        wait(for: [switched], timeout: 1)
        captions.feed(samples, atMs: 10)
        captions.finish(timeout: 1)
        XCTAssertEqual(second.appended, [0, 10])
        XCTAssertEqual(events.named("captions_status").compactMap { $0["status"] as? String }, ["live"])
    }

    func testCaptionsGoOffWhenTheFirstEngineAndEverySwitchFail() {
        let events = Events()
        var ready: ((Result<SpeechEngine, CaptionUnavailable>) -> Void)?
        var answerSwitch: ((Result<SpeechEngine, CaptionUnavailable>) -> Void)?
        let captions = LiveCaptions(track: "mic", emit: events.emit) { ready = $0 }
        let answered = expectation(description: "answered")
        captions.switchEngine({ answerSwitch = $0 }, outcome: { _ in answered.fulfill() })
        ready?(.failure(CaptionUnavailable(reason: "no model for en-US")))
        answerSwitch?(.failure(CaptionUnavailable(reason: "no model for es-ES")))
        wait(for: [answered], timeout: 1)
        captions.finish(timeout: 1)
        let statuses = events.named("captions_status")
        XCTAssertEqual(statuses.compactMap { $0["status"] as? String }, ["unavailable"])
        XCTAssertEqual(statuses.first?["reason"] as? String, "no model for en-US")
    }

    func testAnOvertakenSwitchLetsGoOfItsEngine() {
        let first = FakeEngine()
        let late = FakeEngine()
        let latest = FakeEngine()
        let captions = LiveCaptions(track: "mic", emit: { _ in }) { $0(.success(first)) }
        captions.feed(samples, atMs: 0)
        var answerLate: ((Result<SpeechEngine, CaptionUnavailable>) -> Void)?
        var outcomes: [EngineSwitch] = []
        let lock = NSLock()
        let both = expectation(description: "both answered")
        both.expectedFulfillmentCount = 2
        let record: (EngineSwitch) -> Void = {
            lock.lock()
            outcomes.append($0)
            lock.unlock()
            both.fulfill()
        }
        captions.switchEngine({ answerLate = $0 }, outcome: record)
        captions.switchEngine({ $0(.success(latest)) }, outcome: record)
        answerLate?(.success(late))
        wait(for: [both], timeout: 1)
        captions.feed(samples, atMs: 10)
        captions.finish(timeout: 1)
        XCTAssertEqual(outcomes, [.switched, .superseded])
        XCTAssertEqual(latest.appended, [10])
        XCTAssertTrue(late.appended.isEmpty)
        XCTAssertTrue(late.finished)
    }

    func testFinalsReachTheLanguageFollower() {
        let engine = FakeEngine()
        var finals: [String] = []
        let captions = LiveCaptions(track: "mic", emit: { _ in }, onFinal: { text, _ in finals.append(text) }) {
            $0(.success(engine))
        }
        captions.feed(samples, atMs: 0)
        captions.finish(timeout: 1)
        engine.sink?.recognized(text: "partial", isFinal: false, startMs: 0, endMs: 1)
        XCTAssertEqual(finals, ["last words"])
    }

    func testAudioHeldBeforeTheEngineIsReadyKeepsOnlyTheLatestTenSeconds() {
        let events = Events()
        let engine = FakeEngine()
        var ready: ((Result<SpeechEngine, CaptionUnavailable>) -> Void)?
        let captions = LiveCaptions(track: "mic", emit: events.emit) { ready = $0 }
        let second = [Float](repeating: 0.1, count: 48_000)
        for s in 0..<30 { captions.feed(second, atMs: Int64(s) * 1_000) }
        ready?(.success(engine))
        captions.finish(timeout: 1)
        XCTAssertEqual(engine.appended, (20..<30).map { Int64($0) * 1_000 }, "oldest audio goes first")
        let done = events.named("captions_done").first
        XCTAssertEqual(done?["dropped"] as? Int, 20)
        XCTAssertEqual(done?["timedOut"] as? Bool, false)
        XCTAssertEqual(done?["failed"] as? Bool, false)
    }

    func testAudioAnEngineLetsGoOfIsSaidAtOnceAndCounted() {
        let events = Events()
        let engine = FakeEngine()
        let captions = LiveCaptions(track: "mic", emit: events.emit) { $0(.success(engine)) }
        captions.feed([Float](repeating: 0.1, count: 4_800), atMs: 0)
        let deadline = Date().addingTimeInterval(1)
        while engine.appended.isEmpty, Date() < deadline { usleep(1_000) }
        XCTAssertNotNil(engine.sink)
        engine.sink?.audioDropped(2)
        engine.sink?.audioDropped(1)
        XCTAssertEqual(events.named("captions_dropped").count, 1, "the first loss is enough to know")
        XCTAssertEqual(events.named("captions_dropped").first?["dropped"] as? Int, 2)
        captions.finish(timeout: 1)
        XCTAssertEqual(events.named("captions_done").first?["dropped"] as? Int, 3)
    }

    func testFinishReportsATimeoutAndAFailure() {
        final class Stuck: SpeechEngine {
            let name = "stuck"
            func start(sink: CaptionSink) throws {}
            func append(_ buffer: AVAudioPCMBuffer, atMs: Int64) throws {}
            func finish(_ done: @escaping () -> Void) {}
        }
        let stuckEvents = Events()
        let stuck = LiveCaptions(track: "mic", emit: stuckEvents.emit) { $0(.success(Stuck())) }
        stuck.feed(samples, atMs: 0)
        stuck.finish(timeout: 0.2)
        XCTAssertEqual(stuckEvents.named("captions_done").first?["timedOut"] as? Bool, true)

        let brokenEvents = Events()
        let broken = FakeEngine()
        broken.failOnAppend = 1
        let failing = LiveCaptions(track: "mic", emit: brokenEvents.emit) { $0(.success(broken)) }
        failing.feed(samples, atMs: 0)
        failing.finish(timeout: 1)
        XCTAssertEqual(brokenEvents.named("captions_done").first?["failed"] as? Bool, true)
    }

    func testSummaryEncodes() throws {
        let line = try XCTUnwrap(
            EventEmitter.line(CaptionSummary(dropped: 3, timedOut: false, failed: true).json(track: "mic")))
        XCTAssertEqual(
            String(decoding: line, as: UTF8.self),
            #"{"dropped":3,"event":"captions_done","failed":true,"timedOut":false,"track":"mic"}"# + "\n")
    }

    /// CI's log says which engines its toolchain compiled; the macOS 26 one
    /// needs Swift 6.2 (Xcode 26).
    func testReportsWhichEnginesThisToolchainBuilds() {
        #if compiler(>=6.2)
            print("caption engines compiled: speech-analyzer, sfspeech")
        #else
            print("caption engines compiled: sfspeech only (compiler older than 6.2)")
        #endif
    }
}

final class SFSpeechRolloverTests: XCTestCase {
    func testWaitsForAPauseAfterThirtySeconds() {
        XCTAssertFalse(SFSpeechEngine.rollsOver(elapsedMs: 29_000, quietMs: 1_000))
        XCTAssertFalse(SFSpeechEngine.rollsOver(elapsedMs: 31_000, quietMs: 100))
        XCTAssertTrue(SFSpeechEngine.rollsOver(elapsedMs: 31_000, quietMs: 250))
    }

    func testRollsOverAtTheCapEvenMidSpeech() {
        XCTAssertTrue(SFSpeechEngine.rollsOver(elapsedMs: 45_000, quietMs: 0))
    }

    func testMeasuresBufferLoudness() throws {
        let silent = try XCTUnwrap(LiveCaptions.pcmBuffer([Float](repeating: 0, count: 480)))
        let loud = try XCTUnwrap(LiveCaptions.pcmBuffer([Float](repeating: 0.2, count: 480)))
        XCTAssertLessThan(SFSpeechEngine.rms(silent), SFSpeechEngine.pauseRms)
        XCTAssertEqual(SFSpeechEngine.rms(loud), 0.2, accuracy: 0.0001)
    }
}
