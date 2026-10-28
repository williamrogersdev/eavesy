import XCTest
@testable import SwiftAudio

final class SpellerTests: XCTestCase {
    /// Words with times in ms: ("so", 0, 300).
    private func words(_ timed: [(String, Int64, Int64)]) -> [HeardWord] {
        timed.enumerated().map { index, word in
            HeardWord(text: (index == 0 ? "" : " ") + word.0, startMs: word.1, endMs: word.2)
        }
    }

    private func final(_ timed: [(String, Int64, Int64)]) -> Heard {
        let words = words(timed)
        return Heard(
            text: words.map(\.text).joined(), isFinal: true, startMs: words[0].startMs,
            endMs: words[words.count - 1].endMs, words: words)
    }

    private func speller(_ vocabulary: [String], heard: [(String, Int64, Int64)]) -> Speller {
        var speller = Speller(vocabulary: vocabulary)
        speller.hear(words(heard))
        return speller
    }

    func testTheUsersWordReplacesWhatWasMisheardOverTheSameAudio() {
        let speller = speller(["Repackify"], heard: [("to", 2640, 3200), ("Repackify", 3450, 4140), ("support", 4260, 4500)])
        let spelled = speller.spell(final([("to", 2640, 3240), ("repack", 3240, 3700), ("of", 3700, 4260), ("support.", 4260, 4500)]))
        XCTAssertEqual(spelled.text, "to Repackify support.")
        XCTAssertEqual(spelled.words.map(\.text), ["to", " Repackify", " support."])
    }

    func testWordsSaidApartAndNumbersSaidAsWordsBecomeTheUsersSpelling() {
        let speller = speller(
            ["cloudflare", "1db"], heard: [("1db", 1320, 2250), ("on", 2300, 2400), ("cloudflare.", 2450, 3100)])
        let spelled = speller.spell(
            final([("One", 1260, 1560), ("DB", 1560, 2160), ("on", 2200, 2400), ("cloud", 2400, 2700), ("flare.", 2700, 3060)]))
        XCTAssertEqual(spelled.text, "1db on cloudflare.")
    }

    func testALowercaseWordStartingASentenceKeepsItsCapital() {
        let speller = speller(["convex"], heard: [("convex", 960, 1530)])
        XCTAssertEqual(speller.spell(final([("Konvex", 900, 1440), ("works.", 1440, 1900)])).text, "Convex works.")
    }

    func testWordsThatSoundDifferentStay() {
        let speller = speller(["Pallets"], heard: [("pallets", 11940, 12240)])
        let heard = final([("on", 11340, 11640), ("quantity", 11640, 12060), ("and", 12060, 12240), ("we", 12240, 13080)])
        XCTAssertEqual(speller.spell(heard), heard)
    }

    func testALongerWordContainingTheUsersWordStays() {
        let speller = speller(["Rust"], heard: [("rust", 23040, 23460)])
        let heard = final([("it's", 22000, 22320), ("rust-based,", 22320, 23940), ("um", 23940, 24240)])
        XCTAssertEqual(speller.spell(heard), heard)
    }

    func testTheRightWordInTheSingularStays() {
        let speller = speller(["Gaylord Boxes"], heard: [("Gaylord", 78660, 79000), ("Boxes", 79000, 79320)])
        let heard = final([("a", 78480, 78660), ("Gaylord", 78660, 78960), ("box,", 78960, 79320)])
        XCTAssertEqual(speller.spell(heard), heard)
    }

    func testNothingChangesWithoutTheUsersWordsOverTheFinal() {
        let speller = speller(["Repackify"], heard: [("Repackify", 30000, 30600)])
        let heard = final([("repack", 1000, 1400), ("of", 1400, 1700)])
        XCTAssertEqual(speller.spell(heard), heard)
        XCTAssertEqual(Speller(vocabulary: []).spell(heard), heard)
    }

    func testLikenessCountsSharedLettersAndRefusesVeryDifferentLengths() {
        XCTAssertEqual(Speller.likeness("pallet", "pallet"), 1)
        XCTAssertEqual(Speller.likeness("palettes", "pallets"), 0.8, accuracy: 0.01)
        XCTAssertEqual(Speller.likeness("rustbased", "rust"), 0)
        XCTAssertEqual(Speller.likeness("", "rust"), 0)
    }
}
