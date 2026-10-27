import XCTest

@testable import SwiftAudio

/// Results shaped like the macOS 26 transcribers': volatile results are one
/// untimed run over the whole unsettled stretch, finals are timed per word.
final class LiveDraftTests: XCTestCase {
    private func volatile(_ text: String, _ startMs: Int64, _ endMs: Int64) -> Heard {
        Heard(text: text, isFinal: false, startMs: startMs, endMs: endMs)
    }

    private func final(_ words: [(String, Int64, Int64)]) -> Heard {
        let heard = words.map { HeardWord(text: $0.0, startMs: $0.1, endMs: $0.2) }
        return Heard(
            text: heard.map(\.text).joined(), isFinal: true, startMs: heard.first!.startMs,
            endMs: heard.last!.endMs, words: heard)
    }

    private func partial(_ text: String, _ startMs: Int64, _ endMs: Int64, preview: Bool) -> DraftCaption {
        DraftCaption(text: text, isFinal: false, startMs: startMs, endMs: endMs, preview: preview)
    }

    func testFastWordsShowBeforeTheAccurateTranscriberHasAny() {
        var draft = LiveDraft()
        XCTAssertEqual(draft.fast(volatile("Okay, so on the", 0, 1_100)), [partial("Okay, so on the", 0, 1_100, preview: true)])
        XCTAssertEqual(
            draft.fast(volatile("Okay, so on the quarterly numbers", 0, 2_000)),
            [partial("Okay, so on the quarterly numbers", 0, 2_000, preview: true)])
    }

    func testAccurateTextReplacesFastWordsItCoversUnderTheSameStart() {
        var draft = LiveDraft()
        _ = draft.fast(volatile("Okay, so on the", 0, 1_000))
        _ = draft.fast(volatile("Okay, so on the quarterly numbers", 0, 2_000))
        _ = draft.fast(volatile("Okay, so on the quarterly numbers from Cubernates", 0, 3_000))
        // The accurate one has heard the first two seconds; the fast one's
        // words past that point fill in the rest.
        XCTAssertEqual(
            draft.accurate(volatile("Okay, so I'm the quarterly numbers", 0, 2_000)),
            [partial("Okay, so I'm the quarterly numbers from Cubernates", 0, 3_000, preview: true)])
        // Caught up: accurate text alone, no longer a preview.
        XCTAssertEqual(
            draft.accurate(volatile("Okay, so I'm the quarterly numbers from Kubernitz", 0, 3_000)),
            [partial("Okay, so I'm the quarterly numbers from Kubernitz", 0, 3_000, preview: false)])
    }

    func testAnAccurateFinalIsSentUnderTheShownStartThenAsItselfThenTheRestMovesOn() {
        var draft = LiveDraft()
        _ = draft.fast(volatile("So the posters migration look fine,", 0, 4_000))
        _ = draft.fast(volatile("So the posters migration look fine, but Siobhan said", 0, 5_000))
        let out = draft.accurate(final([("So", 100, 300), (" the", 300, 500), (" post", 500, 900), (" migration", 900, 1_800), (" looks fine.", 1_800, 3_900)]))
        XCTAssertEqual(out.count, 3)
        // Same start as what the HUD shows, with the final's words: the HUD
        // drops the fast words, then the final replaces this.
        XCTAssertEqual(out[0], partial("So the post migration looks fine.", 0, 3_900, preview: false))
        XCTAssertEqual(
            out[1], DraftCaption(text: "So the post migration looks fine.", isFinal: true, startMs: 100, endMs: 3_900, preview: false))
        // What is left starts a new stretch after the final, so it sorts after it.
        XCTAssertEqual(out[2], partial("but Siobhan said", 3_900, 5_000, preview: true))
    }

    func testFastFinalsAreSlicedByTheirWordTimesAndNeverSentAsFinals() {
        var draft = LiveDraft()
        _ = draft.accurate(volatile("Kind of flaky", 6_000, 7_000))
        let out = draft.fast(final([(" kind", 6_100, 6_400), (" of", 6_400, 6_600), (" flaky", 6_600, 6_900), (" on", 7_000, 7_200), (" Tuesday.", 7_200, 7_700)]))
        XCTAssertEqual(out, [partial("Kind of flaky on Tuesday.", 6_000, 7_700, preview: true)])
        XCTAssertFalse(out.contains { $0.isFinal })
    }

    func testAFastWordStillBeingSaidWhereTheAccurateTextStopsIsKept() {
        var draft = LiveDraft()
        _ = draft.accurate(volatile("kind of flaky", 6_000, 7_789))
        XCTAssertEqual(
            draft.fast(final([(" flaky", 7_100, 7_560), (" on", 7_560, 7_740), (" Tuesday.", 7_740, 8_220)])),
            [partial("kind of flaky Tuesday.", 6_000, 8_220, preview: true)])
    }

    func testAFastFinalWordStraddlingWhereTheAccurateFinalEndedIsKept() {
        var draft = LiveDraft()
        _ = draft.accurate(final([("Ship", 1_000, 1_400), (" it", 1_400, 2_000)]))
        XCTAssertEqual(
            draft.fast(final([(" the", 1_800, 2_200), (" plan", 2_200, 2_600)])),
            [partial("the plan", 2_000, 2_600, preview: true)])
    }

    func testNoSnapshotNearTheAccurateTextShowsNoVolatileFastWords() {
        var draft = LiveDraft()
        _ = draft.fast(volatile("one two", 0, 1_000))
        _ = draft.fast(volatile("one two three four five six seven eight", 0, 8_000))
        // The nearest snapshot is two seconds off, so how many fast words the
        // accurate text covers is unknown: show the accurate text alone.
        XCTAssertEqual(
            draft.accurate(volatile("one two three", 0, 3_000)),
            [partial("one two three", 0, 3_000, preview: false)])
    }

    func testStoppingThePreviewLeavesTheAccurateTextAlone() {
        var draft = LiveDraft()
        _ = draft.accurate(volatile("Let's sync with", 8_000, 9_000))
        _ = draft.fast(volatile("Let's sync with", 8_000, 9_000))
        _ = draft.fast(volatile("Let's sync with W about the API", 8_000, 10_000))
        XCTAssertEqual(draft.stopPreview(), [partial("Let's sync with", 8_000, 9_000, preview: false)])
        XCTAssertEqual(draft.fast(volatile("Let's sync with W about the API rate limits", 8_000, 11_000)), [])
        XCTAssertEqual(
            draft.accurate(volatile("Let's sync with Wyn about", 8_000, 10_000)),
            [partial("Let's sync with Wyn about", 8_000, 10_000, preview: false)])
    }

    func testOnlyFastWordsAtStopHaveNothingAccurateToRestore() {
        var draft = LiveDraft()
        _ = draft.fast(volatile("Hello", 0, 1_000))
        XCTAssertEqual(draft.stopPreview(), [])
        // The accurate final still replaces the fast words under their start.
        XCTAssertEqual(
            draft.accurate(final([("Hello.", 200, 700)])).first,
            partial("Hello.", 0, 700, preview: false))
    }

    func testUnchangedTextIsNotSentAgain() {
        var draft = LiveDraft()
        XCTAssertEqual(draft.accurate(volatile("All right", 12_800, 13_500)).count, 1)
        XCTAssertEqual(draft.accurate(volatile("All right", 12_800, 13_500)), [])
        XCTAssertEqual(draft.fast(volatile("All right", 12_800, 13_500)), [])
    }

    func testAFinalWithNoShownTextIsSentAsItIs() {
        var draft = LiveDraft()
        XCTAssertEqual(
            draft.accurate(final([("Yes.", 0, 400)])),
            [DraftCaption(text: "Yes.", isFinal: true, startMs: 0, endMs: 400, preview: false)])
        XCTAssertEqual(draft.accurate(volatile("stale", 0, 400)), [])
    }
}
