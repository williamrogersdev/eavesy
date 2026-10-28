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

/// Collects how each track's switch ended. Captions only count as unable to
/// speak a language when no track could, so one track that fails does not
/// undo the others.
final class SwitchTally {
    enum Result: Equatable {
        /// Some tracks have not answered yet.
        case pending
        /// At least one track moved to the language.
        case switched
        /// None moved, but a later switch overtook some: that one decides.
        case overtaken
        /// No track could move; why, per track.
        case failed([String])
    }

    private let lock = NSLock()
    private var waiting: Int
    private var switched = 0
    private var overtaken = 0
    private var reasons: [String] = []

    init(tracks: Int) {
        waiting = tracks
    }

    func record(_ outcome: EngineSwitch) -> Result {
        lock.lock()
        defer { lock.unlock() }
        waiting -= 1
        switch outcome {
        case .switched: switched += 1
        case .superseded: overtaken += 1
        case .unavailable(let reason): reasons.append(reason)
        }
        if waiting > 0 { return .pending }
        if switched > 0 { return .switched }
        if overtaken > 0 { return .overtaken }
        return .failed(reasons)
    }
}

/// Moves every captioned track to the language `LanguageFollower` picks.
final class CaptionLanguages {
    private let follower: LanguageFollower
    private let current: Locale
    private let vocabulary: [String]
    private let preview: Bool
    private let spell: Bool
    private let lock = NSLock()
    private var tracks: [LiveCaptions] = []
    private var lastMs: Int64 = 0
    private var knownLocales: [Locale]?
    /// The language the engines are actually running in.
    private var running: String

    init(locale: Locale, follows: Bool, vocabulary: [String], preview: Bool, spell: Bool) {
        let current = Locale.current
        self.current = current
        self.vocabulary = vocabulary
        self.preview = preview
        self.spell = spell
        running = CaptionLanguage.base(of: locale)
        var resolve: ((String) -> Locale?)?
        follower = LanguageFollower(current: locale, follows: follows) { language in
            resolve?(language) != nil
        }
        resolve = { [weak self] language in self?.locale(for: language) }
    }

    /// Asked of the Speech framework the first time a switch needs it, not at start.
    private var supported: [Locale] {
        lock.lock()
        defer { lock.unlock() }
        if let knownLocales { return knownLocales }
        let locales = CaptionLanguage.supportedLocales()
        knownLocales = locales
        return locales
    }

    private func locale(for language: String) -> Locale? {
        CaptionLanguage.locale(for: language, current: current, supported: supported)
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
        if let language = follower.heard(text, atMs: endMs) {
            switchTo(language)
        }
    }

    /// The host's word on what the cloud heard most recently.
    func cloudHeard(_ language: String) {
        lock.lock()
        let atMs = lastMs
        lock.unlock()
        if let switched = follower.cloudHeard(language, atMs: atMs) {
            switchTo(switched)
        }
    }

    private var runningLanguage: String {
        get {
            lock.lock()
            defer { lock.unlock() }
            return running
        }
        set {
            lock.lock()
            running = newValue
            lock.unlock()
        }
    }

    private func switchTo(_ language: String) {
        let tracks = captions
        guard let locale = locale(for: language), !tracks.isEmpty else {
            follower.failed(language, previous: runningLanguage)
            return
        }
        let vocabulary = self.vocabulary
        let preview = self.preview
        let spell = self.spell
        let follower = self.follower
        let tally = SwitchTally(tracks: tracks.count)
        for track in tracks {
            track.switchEngine({ ready in
                CaptionEngines.make(
                    locale: locale, vocabulary: vocabulary, preview: preview, spell: spell, completion: ready)
            }, outcome: { outcome in
                if outcome == .switched {
                    EventEmitter.emit(["event": "captions_language", "track": track.track, "language": locale.identifier])
                }
                switch tally.record(outcome) {
                case .pending, .overtaken:
                    break
                case .switched:
                    self.runningLanguage = language
                case .failed(let reasons):
                    let running = self.runningLanguage
                    follower.failed(language, previous: running)
                    FileHandle.standardError.write(
                        Data("captions stay in \(running), not \(language): \(reasons.joined(separator: "; "))\n".utf8))
                }
            })
        }
    }
}
