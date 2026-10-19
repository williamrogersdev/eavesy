import Foundation
import NaturalLanguage
import Speech

/// The language live captions are in, and how a cloud language code (Whisper's
/// ISO 639-1, plus `auto`) becomes a locale an on-device recognizer speaks.
enum CaptionLanguage {
    /// The cloud setting that detects the spoken language itself.
    static let auto = "auto"

    /// Whisper and NaturalLanguage name a few languages differently from the
    /// speech recognizers: Norwegian, Tagalog, and Chinese written forms.
    private static let aliases = ["no": "nb", "nn": "nb", "tl": "fil", "zh-hans": "zh", "zh-hant": "zh"]

    /// A language code reduced to what recognizers are keyed on: `es-MX` is `es`.
    static func base(_ code: String) -> String {
        let lowered = code.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: "_", with: "-")
        if let alias = aliases[lowered] { return alias }
        let first = String(lowered.split(separator: "-").first ?? "")
        return aliases[first] ?? first
    }

    static func base(of locale: Locale) -> String {
        base(locale.identifier)
    }

    /// The recognizer locale for `language`: the user's own regional variant
    /// when the system already speaks it, else the variant the user's region
    /// uses, else the language's most common one. `supported` is what this Mac
    /// can recognize; when it is empty (unknown) the bare language is used.
    /// Nil when nothing on this Mac speaks the language.
    static func locale(for language: String, current: Locale, supported: [Locale]) -> Locale? {
        let wanted = base(language)
        guard !wanted.isEmpty, wanted != auto else { return nil }
        if base(of: current) == wanted { return current }
        guard !supported.isEmpty else { return Locale(identifier: wanted) }
        let candidates = supported
            .filter { base(of: $0) == wanted }
            .sorted { $0.identifier < $1.identifier }
        guard !candidates.isEmpty else { return nil }
        let region = current.region?.identifier
        if let local = candidates.first(where: { $0.region?.identifier == region }) { return local }
        let likely = Locale(identifier: Locale.Language(identifier: wanted).maximalIdentifier).region?.identifier
        if let common = candidates.first(where: { $0.region?.identifier == likely }) { return common }
        return candidates.first
    }

    /// What this Mac's recognizers speak. SpeechAnalyzer's languages are a
    /// subset of these, and `CaptionEngines` falls back to SFSpeech anyway.
    static func supportedLocales() -> [Locale] {
        Array(SFSpeechRecognizer.supportedLocales())
    }

    /// A host hint on stdin, `{"language":"es"}`: what the cloud heard last.
    static func hint(_ line: String) -> String? {
        guard
            let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let code = object["language"] as? String,
            !code.isEmpty
        else { return nil }
        return code
    }

    /// The language of a stretch of caption text, with how sure it is.
    static func detect(_ text: String) -> (language: String, confidence: Double)? {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        guard let (language, confidence) = recognizer.languageHypotheses(withMaximum: 1).first else { return nil }
        return (base(language.rawValue), confidence)
    }
}

/// Decides when captions should move to another language. With a fixed cloud
/// language it never does. With `auto` it listens to two signals:
/// - the cloud's per-line language (Whisper hears the audio, so it is trusted
///   as soon as it arrives, about a segment behind);
/// - the language of the caption text itself, which only moves captions on
///   strong evidence, because a recognizer in the wrong language mostly writes
///   its own language, phonetically.
/// A language no recognizer here speaks, or one whose engine failed to start,
/// is never tried again, so captions carry on as they were.
final class LanguageFollower {
    /// Text detection needs at least this much caption text to go on.
    static let minChars = 80
    /// And this sure a language other than the current one is being spoken.
    static let minConfidence = 0.9
    /// Recent finals kept for detection.
    static let window = 6
    /// Text detection waits this long after a switch before switching again.
    static let dwellMs: Int64 = 20_000

    let follows: Bool
    private(set) var current: String
    private var recent: [String] = []
    private var lastSwitchMs: Int64?
    private var unavailable: Set<String> = []
    private let lock = NSLock()
    private let detect: (String) -> (language: String, confidence: Double)?
    private let canCaption: (String) -> Bool

    init(
        current: Locale,
        follows: Bool,
        detect: @escaping (String) -> (language: String, confidence: Double)? = CaptionLanguage.detect,
        canCaption: @escaping (String) -> Bool
    ) {
        self.current = CaptionLanguage.base(of: current)
        self.follows = follows
        self.detect = detect
        self.canCaption = canCaption
    }

    /// A caption final. Returns the language to switch to, if any.
    func heard(_ text: String, atMs: Int64) -> String? {
        guard follows else { return nil }
        lock.lock()
        defer { lock.unlock() }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        recent.append(trimmed)
        if recent.count > Self.window { recent.removeFirst(recent.count - Self.window) }
        if let last = lastSwitchMs, atMs - last < Self.dwellMs { return nil }
        let joined = recent.joined(separator: " ")
        guard joined.count >= Self.minChars, let (language, confidence) = detect(joined),
            confidence >= Self.minConfidence
        else { return nil }
        return switchTo(language, atMs: atMs)
    }

    /// What the cloud heard in the latest segment.
    func cloudHeard(_ language: String, atMs: Int64) -> String? {
        guard follows else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return switchTo(CaptionLanguage.base(language), atMs: atMs)
    }

    /// The engine for `language` would not start: captions stay in `previous`
    /// and never try `language` again.
    func failed(_ language: String, previous: String) {
        lock.lock()
        let failed = CaptionLanguage.base(language)
        unavailable.insert(failed)
        if current == failed { current = CaptionLanguage.base(previous) }
        lock.unlock()
    }

    /// Called with `lock` held.
    private func switchTo(_ language: String, atMs: Int64) -> String? {
        guard !language.isEmpty, language != CaptionLanguage.auto, language != current,
            !unavailable.contains(language)
        else { return nil }
        guard canCaption(language) else {
            unavailable.insert(language)
            return nil
        }
        current = language
        lastSwitchMs = atMs
        recent.removeAll()
        return language
    }
}

/// Moves every captioned track to the language `LanguageFollower` picks.
final class CaptionLanguages {
    private let follower: LanguageFollower
    private let current: Locale
    private let supported: [Locale]
    private let vocabulary: [String]
    private let lock = NSLock()
    private var tracks: [LiveCaptions] = []
    private var lastMs: Int64 = 0

    init(locale: Locale, follows: Bool, vocabulary: [String]) {
        let current = Locale.current
        let supported = follows ? CaptionLanguage.supportedLocales() : []
        self.current = current
        self.supported = supported
        self.vocabulary = vocabulary
        follower = LanguageFollower(current: locale, follows: follows) { language in
            CaptionLanguage.locale(for: language, current: current, supported: supported) != nil
        }
    }

    var captions: [LiveCaptions] {
        get {
            lock.lock()
            defer { lock.unlock() }
            return tracks
        }
        set {
            lock.lock()
            tracks = newValue
            lock.unlock()
        }
    }

    /// A caption final from any track.
    func heard(_ text: String, endMs: Int64) {
        lock.lock()
        lastMs = max(lastMs, endMs)
        lock.unlock()
        let previous = follower.current
        if let language = follower.heard(text, atMs: endMs) {
            switchTo(language, from: previous)
        }
    }

    /// The host's word on what the cloud heard most recently.
    func cloudHeard(_ language: String) {
        lock.lock()
        let atMs = lastMs
        lock.unlock()
        let previous = follower.current
        if let switched = follower.cloudHeard(language, atMs: atMs) {
            switchTo(switched, from: previous)
        }
    }

    private func switchTo(_ language: String, from previous: String) {
        guard let locale = CaptionLanguage.locale(for: language, current: current, supported: supported) else { return }
        EventEmitter.emit(["event": "captions_language", "language": locale.identifier])
        let vocabulary = self.vocabulary
        let follower = self.follower
        for track in captions {
            track.switchEngine({ ready in
                CaptionEngines.make(locale: locale, vocabulary: vocabulary, completion: ready)
            }, unavailable: { reason in
                follower.failed(language, previous: previous)
                FileHandle.standardError.write(Data("captions stay in \(previous), not \(language): \(reason)\n".utf8))
            })
        }
    }
}
