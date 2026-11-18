import Foundation

/// Spells the user's own words in the accurate transcriber's finals.
///
/// The accurate transcriber (SpeechTranscriber) ignores custom words, so it
/// writes "Repackify" as "repack of" or "Aberpackify". A second one,
/// DictationTranscriber, does take them, but gets more of everything else
/// wrong. Both hear the same audio: where the second one heard one of the
/// user's words, the accurate words said over the same stretch are swapped
/// for it, as long as they sound like it. Everything else stays the accurate
/// transcriber's. desktop/bench/spell-bench.sh measures it: on 60 of the
/// owner's clips it got "Repackify" right 30 times, against 12 for the
/// accurate transcriber alone and 25 for the second one alone.
///
/// "Sound like it" is by letters or, failing that, by consonant sounds: the
/// accurate transcriber writes "Repackify" as "Rebecca 5" or "interpacted",
/// which share few letters with it but its R-P-K-F. Without a second
/// transcriber's word, a name is still spelled where the accurate words hold
/// a non-word and come very close to it ("repackupy", "Repacka Fy's",
/// "repack of 5"); real words ("pacify", "easy", "repack of") are never
/// replaced on spelling alone.
struct Speller {
    /// How alike, 0–1, the accurate words and the user's word must be.
    static let likeness = 0.6
    /// How alike by letters accurate words holding a non-word must be to a
    /// name for it to be spelled with no second transcriber's word over them.
    static let unheardLikeness = 0.75
    /// Words more than this many times longer or shorter than the user's word
    /// are a different word ("rust-based" for "Rust").
    static let lengthRatio = 1.75
    /// The second transcriber's matches kept; finals only look back a little.
    static let maxHits = 500

    private struct Term {
        let spelling: String
        let key: String
        /// How many of the second transcriber's words it can take ("cloud flare").
        let words: Int
        /// Not everyday words ("Repackify", "Gaylord Boxes"), so it may be
        /// spelled from the accurate words alone.
        let isName: Bool
    }

    private struct Hit {
        let term: Term
        let startMs: Int64
        let endMs: Int64
    }

    private let terms: [Term]
    private let english: EnglishWords
    private var hits: [Hit] = []

    init(vocabulary: [String], english: EnglishWords = .system) {
        self.english = english
        terms = vocabulary
            .map {
                let words = Self.words($0)
                return Term(
                    spelling: $0, key: Self.key($0), words: max(1, words.count),
                    isName: Self.key($0).count >= 4 && !EnglishWords.tokens($0).allSatisfy(english.contains))
            }
            .filter { !$0.key.isEmpty }
            .sorted { $0.key.count > $1.key.count }
    }

    var isEmpty: Bool { terms.isEmpty }

    /// Notes where the second transcriber heard one of the user's words, in
    /// one of its finals.
    mutating func hear(_ words: [HeardWord]) {
        let longest = min(3, terms.map(\.words).max() ?? 0)
        var i = 0
        while i < words.count {
            var matched = 0
            for n in stride(from: longest, through: 1, by: -1) where i + n <= words.count {
                let key = Self.key(words[i..<i + n].map(\.text).joined())
                if let term = terms.first(where: { $0.key == key }) {
                    hits.append(Hit(term: term, startMs: words[i].startMs, endMs: words[i + n - 1].endMs))
                    matched = n
                    break
                }
            }
            i += max(matched, 1)
        }
        if hits.count > Self.maxHits { hits.removeFirst(hits.count - Self.maxHits) }
    }

    /// `final` with the user's words spelled their way: where the second
    /// transcriber heard one over words that sound like it, then where the
    /// words hold a non-word very close to a name. Unchanged otherwise.
    func spell(_ final: Heard) -> Heard {
        guard final.isFinal, !final.words.isEmpty else { return final }
        var words = final.words
        var used = Set<Int>()
        var changed = false
        func replace(_ window: ClosedRange<Int>, with term: Term) {
            used.formUnion(window)
            let heard = window.map { words[$0].text }.joined()
            guard Self.words(heard) != Self.words(term.spelling), !Self.onlyNumberDiffers(heard, term.key)
            else { return }
            let first = words[window.lowerBound]
            let last = words[window.upperBound]
            var spelling = term.spelling
            if spelling == spelling.lowercased(), Self.core(first.text).first?.isUppercase == true {
                spelling = spelling.prefix(1).uppercased() + spelling.dropFirst()
            }
            let text = Self.lead(first.text) + spelling + Self.tail(last.text)
            words[window.lowerBound] = HeardWord(text: text, startMs: first.startMs, endMs: last.endMs)
            for index in window.dropFirst() {
                words[index] = HeardWord(text: "", startMs: words[index].startMs, endMs: words[index].endMs)
            }
            changed = true
        }
        for hit in hits where hit.endMs > final.startMs && hit.startMs < final.endMs {
            let over = words.indices.filter {
                !used.contains($0) && words[$0].endMs > hit.startMs && words[$0].startMs < hit.endMs
            }
            guard let window = Self.closest(over, in: words, to: hit) else { continue }
            replace(window, with: hit.term)
        }
        var at = 0
        while at < words.count {
            if !used.contains(at), let (window, term) = unheardName(at: at, in: words, skipping: used) {
                replace(window, with: term)
                at = window.upperBound + 1
            } else {
                at += 1
            }
        }
        guard changed else { return final }
        return Heard(
            text: words.map(\.text).joined(), isFinal: true, startMs: final.startMs, endMs: final.endMs,
            words: words.filter { !$0.text.isEmpty })
    }

    /// A name the accurate words starting at `at` are a mishearing of, with no
    /// second transcriber's word to go on: up to three words, at least one of
    /// them no English word (or a digit, "repack of 5"), none already the
    /// name, very close to it by letters and starting like it.
    private func unheardName(
        at start: Int, in words: [HeardWord], skipping used: Set<Int>
    ) -> (ClosedRange<Int>, Term)? {
        var best: (score: Double, window: ClosedRange<Int>, term: Term)?
        for end in start..<min(start + 3, words.count) {
            if used.contains(end) { break }
            let window = start...end
            let said = window.flatMap { Self.words(words[$0].text) }
            let written = window.flatMap { EnglishWords.tokens(words[$0].text) }
            guard written.contains(where: { $0.first?.isNumber == true || !english.contains($0) }) else { continue }
            let key = Self.spoken(said.joined(separator: " "))
            for term in terms where term.isName && key.first == term.key.first {
                if said.contains(where: { Self.spoken($0).hasPrefix(term.key) }) { continue }
                let score = Self.likeness(key, term.key)
                // It must sound like the name too, not only be spelled like it.
                let text = window.map { words[$0].text }.joined(separator: " ")
                guard score >= Self.unheardLikeness, score > (best?.score ?? 0),
                    Self.likeness(Self.sounds(text), Self.sounds(term.spelling)) >= Self.unheardLikeness
                else { continue }
                best = (score, window, term)
            }
        }
        return best.map { ($0.window, $0.term) }
    }

    /// The run of `over` that sounds most like the hit's term, if any sounds
    /// enough like it, by letters or by consonant sounds. A word can be heard
    /// as a few ("packed to 5"), so a run may hold two more words than the
    /// term. Of runs that sound as alike, a run inside another wins, since the
    /// words around it added no sound ("agent that" is "agent" and "that");
    /// then the one timed most like the hit: "or packed to 5" under
    /// "Repackify" is "packed to 5", not "or packed".
    private static func closest(_ over: [Int], in words: [HeardWord], to hit: Hit) -> ClosedRange<Int>? {
        let term = hit.term
        var runs: [(score: Double, fit: Double, window: ClosedRange<Int>)] = []
        for (a, start) in over.enumerated() {
            for b in a..<min(a + term.words + 2, over.count) {
                let end = over[b]
                guard end - start == b - a else { break }
                let text = words[start...end].map(\.text).joined()
                // Short sound keys say little: "fast" and "Eavesy" share F-S.
                let bySound = sounds(term.spelling).count >= 3 ? likeness(sounds(text), sounds(term.spelling)) : 0
                let score = max(likeness(spoken(text), term.key), bySound)
                let fit = timeFit(words[start].startMs, words[end].endMs, hit.startMs, hit.endMs)
                runs.append((score, fit, start...end))
            }
        }
        guard let top = runs.map(\.score).max(), top >= likeness else { return nil }
        let tied = runs.filter { top - $0.score < 0.001 }
        let innermost = tied.filter { run in
            !tied.contains { $0.window != run.window && run.window.contains($0.window.lowerBound)
                && run.window.contains($0.window.upperBound) }
        }
        return innermost.max { $0.fit < $1.fit }?.window
    }

    /// How well two stretches of time line up, 0–1: their overlap over their union.
    private static func timeFit(_ aStart: Int64, _ aEnd: Int64, _ bStart: Int64, _ bEnd: Int64) -> Double {
        let overlap = max(0, min(aEnd, bEnd) - max(aStart, bStart))
        let union = max(aEnd, bEnd) - min(aStart, bStart)
        return union > 0 ? Double(overlap) / Double(union) : 0
    }

    /// The consonants as said, alike ones together: b/p, c/k/g/q, d/t, f/v,
    /// s/z, and numbers as words, so "Rebecca 5" and "Repackify" are both
    /// R-P-K-F. Vowels, h, w and y are left out, and doubled sounds counted once.
    static func sounds(_ text: String) -> String {
        var out = ""
        for word in words(text) {
            // "1db" is said "one D B".
            let letters = Array(word.allSatisfy(\.isNumber) ? (numberWords[word] ?? word)
                : word.map { numberWords[String($0)] ?? String($0) }.joined())
            for (i, letter) in letters.enumerated() {
                let next = i + 1 < letters.count ? letters[i + 1] : nil
                let sound: Character?
                switch letter {
                case "b", "p": sound = "P"
                case "c": sound = (next == "e" || next == "i" || next == "y") ? "S" : "K"
                case "k", "g", "q": sound = "K"
                case "d", "t": sound = "T"
                case "f", "v": sound = "F"
                case "s", "z": sound = "S"
                case "x": sound = "K"
                case "j": sound = "J"
                case "l", "m", "n", "r": sound = Character(letter.uppercased())
                default: sound = nil
                }
                if let sound, out.last != sound { out.append(sound) }
            }
        }
        return out
    }

    /// Characters in common, in order, against both lengths (0–1).
    static func likeness(_ a: String, _ b: String) -> Double {
        let a = Array(a), b = Array(b)
        guard !a.isEmpty, !b.isEmpty, Double(max(a.count, b.count)) <= lengthRatio * Double(min(a.count, b.count))
        else { return 0 }
        var previous = [Int](repeating: 0, count: b.count + 1)
        for x in a {
            var current = [0]
            for (j, y) in b.enumerated() {
                current.append(x == y ? previous[j] + 1 : max(previous[j + 1], current[j]))
            }
            previous = current
        }
        return 2 * Double(previous[b.count]) / Double(a.count + b.count)
    }

    /// "Gaylord box" for "Gaylord Boxes": the right word, said in the singular.
    private static func onlyNumberDiffers(_ heard: String, _ key: String) -> Bool {
        let said = spoken(heard)
        func stem(_ s: String) -> Substring {
            var s = Substring(s)
            while s.hasSuffix("s") { s = s.dropLast() }
            while s.hasSuffix("e") { s = s.dropLast() }
            return s
        }
        return key.hasSuffix("s") && !said.hasSuffix("s") && stem(key) == stem(said)
    }

    private static let numbers = [
        "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7",
        "eight": "8", "nine": "9", "ten": "10",
    ]

    private static let numberWords = Dictionary(uniqueKeysWithValues: numbers.map { ($0.value, $0.key) })

    static func words(_ text: String) -> [String] {
        text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }

    static func key(_ text: String) -> String { words(text).joined() }

    /// As said: "one DB" is "1db".
    static func spoken(_ text: String) -> String { words(text).map { numbers[$0] ?? $0 }.joined() }

    private static func core(_ text: String) -> Substring {
        text.drop { !$0.isLetter && !$0.isNumber }
    }

    private static func lead(_ text: String) -> String {
        String(text.prefix { !$0.isLetter && !$0.isNumber })
    }

    private static func tail(_ text: String) -> String {
        guard let last = text.lastIndex(where: { $0.isLetter || $0.isNumber }) else { return "" }
        return String(text[text.index(after: last)...])
    }
}
