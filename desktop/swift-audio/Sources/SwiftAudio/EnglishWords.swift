import Foundation

/// Whether a word is English, from the word list every Mac ships
/// (/usr/share/dict/words). It holds base forms only, so common endings
/// ("admins", "packed", "looking", "team's") are taken off before looking.
///
/// Used only to keep the `Speller` from spelling a name over real words on
/// letters alone. Without the list every word counts as English, which turns
/// that off rather than letting it run over everything.
struct EnglishWords: Sendable {
    private let words: Set<String>?

    init(_ words: Set<String>?) {
        self.words = words.map { Set($0.map { $0.lowercased() }) }
    }

    /// The Mac's own list, read once.
    static let system = EnglishWords(
        (try? String(contentsOfFile: "/usr/share/dict/words", encoding: .utf8))
            .map { Set($0.split(separator: "\n").map { $0.lowercased() }) })

    private static let endings = ["'s", "s", "es", "ed", "d", "ing", "er", "ers", "ly"]

    func contains(_ word: String) -> Bool {
        guard let words else { return true }
        let word = word.lowercased().replacingOccurrences(of: "’", with: "'")
        if word.isEmpty || words.contains(word) { return true }
        // "team's", "we'll", and "aren't", which is "are" + "n't".
        if let apostrophe = word.firstIndex(of: "'") {
            let base = String(word[..<apostrophe])
            if words.contains(base) || (word.hasSuffix("n't") && words.contains(String(base.dropLast()))) { return true }
        }
        for ending in Self.endings where word.count > ending.count + 2 && word.hasSuffix(ending) {
            let stem = String(word.dropLast(ending.count))
            if words.contains(stem) { return true }
            // "companies": the y the ending took.
            if ending == "es", stem.hasSuffix("i"), words.contains(stem.dropLast() + "y") { return true }
            // "stopped", "running": the doubled consonant before the ending.
            if stem.count > 2, stem.last == stem.dropLast().last, words.contains(String(stem.dropLast())) { return true }
            // "making", "used": the e the ending took.
            if ["ing", "ed", "er", "ers"].contains(ending), words.contains(stem + "e") { return true }
        }
        return false
    }

    /// Words as written, apostrophes kept: "aren't" is one English word, not "aren" and "t".
    static func tokens(_ text: String) -> [String] {
        text.lowercased().replacingOccurrences(of: "’", with: "'")
            .split { !$0.isLetter && !$0.isNumber && $0 != "'" }
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "'")) }
            .filter { !$0.isEmpty }
    }
}
