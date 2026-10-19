import Foundation

enum CaptureMode: String {
    case audio
    case screen
}

enum AudioSource: String {
    case system
    case mic
    case mixed
}

struct Arguments {
    /// Segments never close sooner than this, whatever --segment-sec asks for.
    static let minSegmentSec: Double = 30
    static let defaultSegmentSec: Double = 60

    let mode: CaptureMode
    let outPath: String
    let source: AudioSource
    let includeMic: Bool
    let segmentDir: String?
    let segmentSec: Double
    /// Tracks to caption live on-device; empty when captions are off.
    let captions: Set<Track>
    /// Locale for captions: the user's own region when it speaks `--language`.
    let locale: Locale
    /// Words the recognizer should expect, from `--vocabulary`, one per line.
    let vocabulary: [String]

    static func parse(_ argv: [String]) -> Arguments {
        var dict: [String: String] = [:]
        var i = 0
        let args = Array(argv.dropFirst())
        while i < args.count {
            let key = args[i]
            guard key.hasPrefix("--") else {
                i += 1
                continue
            }
            let name = String(key.dropFirst(2))
            if i + 1 < args.count, !args[i + 1].hasPrefix("--") {
                dict[name] = args[i + 1]
                i += 2
            } else {
                dict[name] = "true"
                i += 1
            }
        }

        guard let modeRaw = dict["mode"], let mode = CaptureMode(rawValue: modeRaw) else {
            fail("missing or invalid --mode (expected 'audio' or 'screen')")
        }
        guard let out = dict["out"], !out.isEmpty else {
            fail("missing --out <absolute path>")
        }

        let source: AudioSource
        switch mode {
        case .audio:
            guard let srcRaw = dict["source"], let src = AudioSource(rawValue: srcRaw) else {
                fail("missing or invalid --source (expected 'system', 'mic', or 'mixed')")
            }
            source = src
        case .screen:
            source = .system
        }

        let includeMic = (dict["mic"]?.lowercased() == "true")
        let segmentDir = dict["segment-dir"].flatMap { $0.isEmpty ? nil : $0 }
        let segmentSec = dict["segment-sec"].flatMap(Double.init).map { max($0, minSegmentSec) }
            ?? defaultSegmentSec

        let captions = mode == .audio ? parseCaptions(dict["captions"], source: source) : []
        let locale = captionLocale(language: dict["language"], current: Locale.current)

        return Arguments(
            mode: mode,
            outPath: out,
            source: source,
            includeMic: includeMic,
            segmentDir: segmentDir,
            segmentSec: segmentSec,
            captions: captions,
            locale: locale,
            vocabulary: parseVocabulary(dict["vocabulary"]))
    }

    /// The host sends at most 100 words; this holds to that whatever it sends.
    static func parseVocabulary(_ raw: String?) -> [String] {
        Array(
            (raw ?? "")
                .split(separator: "\n")
                .map { String($0.trimmingCharacters(in: .whitespaces).prefix(60)) }
                .filter { !$0.isEmpty }
                .prefix(100))
    }

    /// The cloud transcribes in one language; caption in the same one, keeping
    /// the user's regional variant (en-GB, en-AU) when the system already speaks it.
    static func captionLocale(language: String?, current: Locale) -> Locale {
        guard let language, !language.isEmpty else { return current }
        if current.language.languageCode?.identifier == language { return current }
        return Locale(identifier: language)
    }

    /// `--captions mic|system|all`, limited to the tracks the source records.
    static func parseCaptions(_ raw: String?, source: AudioSource) -> Set<Track> {
        let recorded: Set<Track>
        switch source {
        case .mic: recorded = [.mic]
        case .system: recorded = [.system]
        case .mixed: recorded = [.mic, .system]
        }
        switch raw?.lowercased() {
        case "all", "true": return recorded
        case let name?: return recorded.intersection(Track(rawValue: name).map { [$0] } ?? [])
        case nil: return []
        }
    }
}

/// A segment closes at the first quiet moment after `segmentSec`, and no later
/// than this. The slack is half the target, capped at a minute, so short
/// segments stay short and four-minute ones still seal at five.
func hardCapSec(forSegmentSec segmentSec: Double) -> Double {
    segmentSec + min(60, segmentSec / 2)
}
