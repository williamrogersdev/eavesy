import Foundation

/// Spells the user's own words in the accurate transcriber's finals.
///
/// The accurate transcriber (SpeechTranscriber) ignores custom words, so it
/// writes "Repackify" as "repack of" or "Aberpackify". A second one,
/// DictationTranscriber, does take them, but gets more of everything else
/// wrong. Both hear the same audio: where the second one heard one of the
/// user's words, the accurate words said over the same stretch are swapped
/// for it, as long as they sound like it. Everything else stays the accurate
/// transcriber's. On 80 of the owner's recordings this got 39 of 75
/// dictionary words right, against 15 for the accurate one alone and 38 for
/// the second one alone, and fewer words wrong overall than either.
struct Speller {
    /// How alike, 0–1, the accurate words and the user's word must be.
    static let likeness = 0.6
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
    }

    private struct Hit {
        let term: Term
        let startMs: Int64
        let endMs: Int64
    }

    private let terms: [Term]
    private var hits: [Hit] = []

    init(vocabulary: [String]) {
        terms = vocabulary
            .map { Term(spelling: $0, key: Self.key($0), words: max(1, Self.words($0).count)) }
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

    /// `final` with the user's words spelled their way; unchanged when none
    /// was heard over it.
    func spell(_ final: Heard) -> Heard {
        guard final.isFinal, !final.words.isEmpty else { return final }
        var words = final.words
        var used = Set<Int>()
        var changed = false
        for hit in hits where hit.endMs > final.startMs && hit.startMs < final.endMs {
            let over = words.indices.filter {
                !used.contains($0) && words[$0].endMs > hit.startMs && words[$0].startMs < hit.endMs
            }
            guard let window = Self.closest(over, in: words, to: hit.term) else { continue }
            used.formUnion(window)
            let heard = window.map { words[$0].text }.joined()
            guard Self.words(heard) != Self.words(hit.term.spelling), !Self.onlyNumberDiffers(heard, hit.term.key)
            else { continue }
            let first = words[window.lowerBound]
            let last = words[window.upperBound]
            var spelling = hit.term.spelling
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
        guard changed else { return final }
        return Heard(
            text: words.map(\.text).joined(), isFinal: true, startMs: final.startMs, endMs: final.endMs,
            words: words.filter { !$0.text.isEmpty })
    }

    /// The run of `over` that sounds most like `term`, if any sounds enough like it.
    private static func closest(_ over: [Int], in words: [HeardWord], to term: Term) -> ClosedRange<Int>? {
        var best: (score: Double, window: ClosedRange<Int>)?
        for (a, start) in over.enumerated() {
            for b in a..<min(a + term.words + 1, over.count) {
                let end = over[b]
                guard end - start == b - a else { break }
                let said = spoken(words[start...end].map(\.text).joined())
                let score = likeness(said, term.key)
                if score > (best?.score ?? 0) { best = (score, start...end) }
            }
        }
        guard let best, best.score >= likeness else { return nil }
        return best.window
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
