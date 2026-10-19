import XCTest
@testable import SwiftAudio

final class CaptionLanguageTests: XCTestCase {
    private let supported = ["en-US", "en-GB", "es-ES", "es-MX", "nb-NO", "fil-PH", "zh-CN", "zh-TW", "yue-CN"]
        .map(Locale.init(identifier:))

    func testCloudCodesMeetRecognizerLocales() {
        XCTAssertEqual(CaptionLanguage.base("es-MX"), "es")
        XCTAssertEqual(CaptionLanguage.base("en_GB"), "en")
        XCTAssertEqual(CaptionLanguage.base("no"), "nb")
        XCTAssertEqual(CaptionLanguage.base("tl"), "fil")
        XCTAssertEqual(CaptionLanguage.base("zh-Hant"), "zh")
        XCTAssertEqual(CaptionLanguage.base("yue-CN"), "yue")
        let us = Locale(identifier: "en_US")
        XCTAssertEqual(CaptionLanguage.locale(for: "no", current: us, supported: supported)?.identifier, "nb-NO")
        XCTAssertEqual(CaptionLanguage.locale(for: "tl", current: us, supported: supported)?.identifier, "fil-PH")
        XCTAssertEqual(CaptionLanguage.locale(for: "zh", current: us, supported: supported)?.identifier, "zh-CN")
        XCTAssertEqual(
            CaptionLanguage.locale(for: "zh", current: Locale(identifier: "en_TW"), supported: supported)?.identifier,
            "zh-TW")
        XCTAssertEqual(CaptionLanguage.locale(for: "yue", current: us, supported: supported)?.identifier, "yue-CN")
        XCTAssertNil(CaptionLanguage.locale(for: "sw", current: us, supported: supported))
        XCTAssertNil(CaptionLanguage.locale(for: "auto", current: us, supported: supported))
    }

    func testHostHintsAreReadFromStdinLines() {
        XCTAssertEqual(CaptionLanguage.hint(#"{"language":"es"}"#), "es")
        XCTAssertNil(CaptionLanguage.hint("stop"))
        XCTAssertNil(CaptionLanguage.hint(#"{"language":""}"#))
    }

    func testDetectsTheLanguageOfCaptionText() {
        let spanish = CaptionLanguage.detect(
            "Buenos días a todos, gracias por venir. Hoy vamos a revisar el presupuesto del próximo trimestre.")
        XCTAssertEqual(spanish?.language, "es")
        XCTAssertGreaterThan(spanish?.confidence ?? 0, LanguageFollower.minConfidence)
    }

    private func follower(
        follows: Bool = true,
        detected: (language: String, confidence: Double)? = ("es", 0.97),
        speaks: Set<String> = ["en", "es", "fr"]
    ) -> LanguageFollower {
        LanguageFollower(
            current: Locale(identifier: "en_US"), follows: follows, detect: { _ in detected },
            canCaption: { speaks.contains($0) })
    }

    private let sentence = "una frase de prueba con suficiente texto"

    func testConfidentDetectionSwitchesOnceThereIsEnoughText() {
        let follower = follower()
        XCTAssertNil(follower.heard(sentence, atMs: 1_000), "one short line is not enough to go on")
        XCTAssertEqual(follower.heard(sentence, atMs: 2_000), "es")
        XCTAssertEqual(follower.current, "es")
        XCTAssertNil(follower.heard(sentence + sentence, atMs: 3_000), "already there")
    }

    func testUnsureDetectionStaysPut() {
        let follower = follower(detected: ("es", 0.6))
        for ms in stride(from: Int64(0), to: 10_000, by: 1_000) {
            XCTAssertNil(follower.heard(sentence, atMs: ms))
        }
        XCTAssertEqual(follower.current, "en")
    }

    func testDetectionWaitsAfterASwitchBeforeSwitchingAgain() {
        var detected = ("es", 0.97)
        let follower = LanguageFollower(
            current: Locale(identifier: "en_US"), follows: true, detect: { _ in detected }, canCaption: { _ in true })
        XCTAssertEqual(follower.heard(sentence + sentence + sentence, atMs: 1_000), "es")
        detected = ("en", 0.97)
        XCTAssertNil(follower.heard(sentence + sentence + sentence, atMs: 5_000))
        XCTAssertEqual(follower.heard(sentence + sentence + sentence, atMs: 1_000 + LanguageFollower.dwellMs), "en")
    }

    func testTheCloudIsTrustedStraightAway() {
        let follower = follower(detected: nil)
        XCTAssertEqual(follower.cloudHeard("fr", atMs: 0), "fr")
        XCTAssertEqual(follower.cloudHeard("es", atMs: 100), "es", "the cloud hears audio, so no waiting")
        XCTAssertNil(follower.cloudHeard("es", atMs: 200))
        XCTAssertNil(follower.cloudHeard("auto", atMs: 300))
    }

    func testAFixedLanguageNeverMoves() {
        let follower = follower(follows: false)
        XCTAssertNil(follower.heard(sentence + sentence + sentence, atMs: 0))
        XCTAssertNil(follower.cloudHeard("es", atMs: 0))
        XCTAssertEqual(follower.current, "en")
    }

    func testALanguageNoRecognizerSpeaksIsLeftAlone() {
        let follower = follower(speaks: ["en"])
        XCTAssertNil(follower.cloudHeard("sw", atMs: 0))
        XCTAssertNil(follower.heard(sentence + sentence + sentence, atMs: 0))
        XCTAssertEqual(follower.current, "en")
    }

    func testAnEngineThatWouldNotStartIsNotTriedAgain() {
        let follower = follower(detected: nil)
        XCTAssertEqual(follower.cloudHeard("es", atMs: 0), "es")
        follower.failed("es", previous: "en")
        XCTAssertEqual(follower.current, "en")
        XCTAssertNil(follower.cloudHeard("es", atMs: 100))
        XCTAssertEqual(follower.cloudHeard("fr", atMs: 200), "fr")
    }

    func testALanguageCountsAsUnavailableOnlyWhenNoTrackCouldSwitch() {
        let mixed = SwitchTally(tracks: 2)
        XCTAssertNil(mixed.record(.unavailable("no model")) as [String]??, "waits for every track")
        XCTAssertEqual(mixed.record(.switched), .some(nil))

        let overtaken = SwitchTally(tracks: 2)
        _ = overtaken.record(.superseded)
        XCTAssertEqual(overtaken.record(.unavailable("no model")), .some(nil))

        let none = SwitchTally(tracks: 2)
        _ = none.record(.unavailable("no model"))
        XCTAssertEqual(none.record(.unavailable("off")), .some(["no model", "off"]))
    }
}
