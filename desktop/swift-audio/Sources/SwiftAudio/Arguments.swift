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
    let mode: CaptureMode
    let outPath: String
    let source: AudioSource
    let includeMic: Bool
    let segmentDir: String?
    let segmentSec: Double

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
        let segmentSec = dict["segment-sec"].flatMap(Double.init).map { max($0, 30) } ?? 240

        return Arguments(
            mode: mode,
            outPath: out,
            source: source,
            includeMic: includeMic,
            segmentDir: segmentDir,
            segmentSec: segmentSec)
    }
}
