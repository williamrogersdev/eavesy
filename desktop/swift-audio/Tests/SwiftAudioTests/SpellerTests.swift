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

    // Real mishearings of "Repackify" from the owner's dictations, where the
    // custom-word transcriber heard it but the letters alone were too far off.
    func testAMishearingThatSoundsLikeTheUsersWordIsSpelledWhereItWasHeard() {
        // Accurate words, the custom-word transcriber's "Repackify" (start, end), and the result.
        let cases: [([(String, Int64, Int64)], (Int64, Int64), String)] = [
            ([("the", 1900, 2190), ("Rebecca", 2190, 2600), ("5", 2600, 2880), ("one.", 2880, 3100)], (2190, 2880),
             "the Repackify one."),
            // "or packed" sounds as much like it, but "packed to 5" is timed like the hit.
            ([("in", 84660, 84900), ("or", 84900, 85560), ("packed", 85560, 85860), ("to", 85860, 85980), ("5", 85980, 86160),
              ("for", 86160, 86340)], (85500, 86190), "in or Repackify for"),
            ([("issue", 23900, 24240), ("interpacted", 24240, 24870), ("by", 24870, 25000)], (24240, 24870),
             "issue Repackify by"),
        ]
        for (accurate, hit, expected) in cases {
            let speller = speller(["Repackify"], heard: [("Repackify", hit.0, hit.1)])
            XCTAssertEqual(speller.spell(final(accurate)).text, expected)
        }
    }

    // Words next to the right one that add no sound stay: the bench once
    // spelled "agent that" as "agent" and "Repackify 5 admins" as "Repackify admins".
    func testWordsBesideTheRightWordStay() {
        let agent = speller(["agent"], heard: [("agent", 1000, 1500)])
        let heard = final([("another", 500, 1000), ("agent", 1000, 1400), ("that", 1400, 1600), ("recently", 1600, 2000)])
        XCTAssertEqual(agent.spell(heard), heard)

        let repackify = speller(["Repackify"], heard: [("Repackify", 1000, 1800)])
        let named = final([("both", 500, 1000), ("Repackify", 1000, 1600), ("5", 1600, 1800), ("admins", 1800, 2200)])
        XCTAssertEqual(repackify.spell(named), named)
        XCTAssertEqual(
            speller(["Repackify"], heard: [("Repackify", 26760, 27300)])
                .spell(final([("that", 25980, 26520), ("repack", 26520, 27000), ("if", 27000, 27180), ("I", 27180, 27300),
                              ("bought,", 27300, 27720)])).text,
            "that Repackify I bought,")
    }

    // The Mac's own word list, as dictation uses it.
    func testRealWordsStayWithTheMacsWordList() throws {
        try XCTSkipIf(EnglishWords.system.contains("zzzqx"), "no word list on this Mac")
        let speller = Speller(vocabulary: ["Eavesy", "Repackify"])
        for text in ["the repack of it", "with easy access", "for pacify well", "the companies repackaged", "we reapplied it"] {
            let heard = final(text.split(separator: " ").enumerated().map { (String($1), Int64($0 * 300), Int64($0 * 300 + 300)) })
            XCTAssertEqual(speller.spell(heard), heard, text)
        }
        XCTAssertEqual(
            speller.spell(final([("what", 0, 300), ("repackupy", 300, 900), ("has", 900, 1100)])).text, "what Repackify has")
    }

    // A short name's few consonants don't make a real word sound like it.
    func testARealWordOverAShortNamesHitStays() {
        let speller = speller(["Eavesy"], heard: [("Eavesy", 1000, 1400)])
        let heard = final([("so", 500, 1000), ("fast", 1000, 1400), ("now", 1400, 1700)])
        XCTAssertEqual(speller.spell(heard), heard)
    }

    private let english = EnglishWords(
        ["what", "has", "on", "there", "for", "pacify", "well", "with", "easy", "is", "repack", "of", "they", "are",
         "be", "being", "used", "it", "the", "one", "plug", "in", "internal", "assistant", "admin"])

    func testANonWordVeryCloseToANameIsSpelledWithoutTheSecondTranscriber() {
        let speller = Speller(vocabulary: ["Eavesy", "Repackify"], english: english)
        XCTAssertEqual(speller.spell(final([("what", 0, 300), ("repackupy", 300, 900), ("has", 900, 1100)])).text, "what Repackify has")
        XCTAssertEqual(
            speller.spell(final([("one", 0, 300), ("repack", 300, 600), ("of", 600, 700), ("5", 700, 900), ("plug-in,", 900, 1300)])).text,
            "one Repackify plug-in,")
        XCTAssertEqual(speller.spell(final([("with", 0, 300), ("Evesy", 300, 700), ("is", 700, 900)])).text, "with Eavesy is")
    }

    func testRealWordsAreNeverSpelledAsANameOnLettersAlone() {
        let speller = Speller(vocabulary: ["Eavesy", "Repackify"], english: english)
        for heard in [
            final([("for", 0, 300), ("Pacify", 300, 800), ("well.", 800, 1000)]),
            final([("with", 0, 300), ("Easy", 300, 700), ("is", 700, 900)]),
            final([("the", 0, 300), ("repack", 300, 600), ("of", 600, 800), ("it", 800, 900)]),
            final([("they", 0, 300), ("aren't", 300, 600), ("being", 600, 900), ("used.", 900, 1200)]),
        ] {
            XCTAssertEqual(speller.spell(heard), heard)
        }
        // Without the word list, nothing is spelled on letters alone.
        let blind = Speller(vocabulary: ["Repackify"], english: EnglishWords(nil))
        let heard = final([("what", 0, 300), ("repackupy", 300, 900)])
        XCTAssertEqual(blind.spell(heard), heard)
    }

    func testEverydayWordsInTheDictionaryAreOnlySpelledWhereTheSecondTranscriberHeardThem() {
        let speller = Speller(vocabulary: ["admin"], english: english)
        let heard = final([("the", 0, 300), ("admn", 300, 700), ("is", 700, 900)])
        XCTAssertEqual(speller.spell(heard), heard)
    }

    func testSoundsKeepsTheConsonantsAsSaid() {
        XCTAssertEqual(Speller.sounds("Repackify"), "RPKF")
        XCTAssertEqual(Speller.sounds("Rebecca 5"), "RPKF")
        XCTAssertEqual(Speller.sounds("Pacify"), "PSF")
        XCTAssertEqual(Speller.sounds("quantity"), "KNT")
    }

    func testEnglishWordsTakesEndingsOffAndKeepsApostrophes() {
        XCTAssertTrue(english.contains("admins"))
        XCTAssertTrue(english.contains("Used"))
        XCTAssertTrue(english.contains("aren't"))
        XCTAssertFalse(english.contains("team's"))
        XCTAssertTrue(EnglishWords(["team", "company"]).contains("team's"))
        XCTAssertTrue(EnglishWords(["company"]).contains("companies"))
        XCTAssertFalse(english.contains("repackupy"))
        XCTAssertEqual(EnglishWords.tokens("They aren’t, Fy's"), ["they", "aren't", "fy's"])
        XCTAssertTrue(EnglishWords(nil).contains("repackupy"))
    }

    func testLikenessCountsSharedLettersAndRefusesVeryDifferentLengths() {
        XCTAssertEqual(Speller.likeness("pallet", "pallet"), 1)
        XCTAssertEqual(Speller.likeness("palettes", "pallets"), 0.8, accuracy: 0.01)
        XCTAssertEqual(Speller.likeness("rustbased", "rust"), 0)
        XCTAssertEqual(Speller.likeness("", "rust"), 0)
    }
}
