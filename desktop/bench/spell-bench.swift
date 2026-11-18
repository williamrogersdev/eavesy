// Offline check of how dictionary words come through on the Mac: runs the
// accurate transcriber and the custom-word one (DictationTranscriber) over
// saved clips, with the custom words applied as a dictation applies them,
// then spells the accurate finals with the production `Speller`.
//
// Build and run with desktop/bench/spell-bench.sh. One JSON line per clip:
// what the accurate transcriber heard, what the custom-word one heard, and
// what the Speller made of the two. Nothing is recorded, played or pasted.
import AVFoundation
import Foundation
import Speech

@available(macOS 26.0, *)
@main struct SpellBench {
    static func main() async throws {
        let args = CommandLine.arguments
        guard args.count == 4 else { fatalError("Usage: spell-bench vocabulary.txt clips.txt out.jsonl") }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            FileHandle.standardError.write(Data("Speech permission unavailable; no prompt was requested\n".utf8))
            exit(78)
        }
        // Like `vocabulary::sidecar_arg`: one word or phrase per line, the app's name first.
        let vocabulary = try String(contentsOfFile: args[1], encoding: .utf8)
            .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let clips = try String(contentsOfFile: args[2], encoding: .utf8)
            .split(separator: "\n").map(String.init).filter { !$0.isEmpty }
        FileManager.default.createFile(atPath: args[3], contents: nil)
        let out = try FileHandle(forWritingTo: URL(fileURLWithPath: args[3]))
        let locale = Locale(identifier: "en_US")

        for clip in clips {
            let url = URL(fileURLWithPath: clip)
            let transcriber = SpeechTranscriber(
                locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults],
                attributeOptions: [.audioTimeRange])
            let accurate = try await run(transcriber, url: url, vocabulary: vocabulary) {
                var heard: [Heard] = []
                for try await result in transcriber.results where result.isFinal {
                    heard.append(Self.heard(result.text, range: result.range))
                }
                return heard
            }
            let dictation = DictationTranscriber(
                locale: locale, contentHints: [], transcriptionOptions: [.punctuation], reportingOptions: [],
                attributeOptions: [.audioTimeRange])
            let spelled = try await run(dictation, url: url, vocabulary: vocabulary) {
                var heard: [Heard] = []
                for try await result in dictation.results where result.isFinal {
                    heard.append(Self.heard(result.text, range: result.range))
                }
                return heard
            }
            var speller = Speller(vocabulary: vocabulary)
            for heard in spelled { speller.hear(heard.words) }
            let spelledFinals = accurate.map { speller.spell($0) }
            let merged = spelledFinals.map(\.text).joined()
            let line: [String: Any] = [
                "clip": clip,
                "accurate": accurate.map(\.text).joined(),
                "spellerHeard": spelled.map(\.text).joined(),
                "merged": merged,
                "accurateWords": accurate.flatMap(\.words).map { ["t": $0.text, "s": $0.startMs, "e": $0.endMs] },
                "spellerWords": spelled.flatMap(\.words).map { ["t": $0.text, "s": $0.startMs, "e": $0.endMs] },
                "mergedWords": spelledFinals.flatMap(\.words).map { ["t": $0.text, "s": $0.startMs, "e": $0.endMs] },
            ]
            out.write(try JSONSerialization.data(withJSONObject: line))
            out.write(Data([10]))
        }
    }

    /// Runs one module over the whole file with the custom words set, and
    /// returns what `collect` gathered from its results.
    static func run(
        _ module: any SpeechModule, url: URL, vocabulary: [String],
        collect: @escaping @Sendable () async throws -> [Heard]
    ) async throws -> [Heard] {
        let analyzer = SpeechAnalyzer(modules: [module])
        if !vocabulary.isEmpty {
            let context = AnalysisContext()
            context.contextualStrings[.general] = vocabulary
            try await analyzer.setContext(context)
        }
        let results = Task { try await collect() }
        let file = try AVAudioFile(forReading: url)
        try await analyzer.start(inputAudioFile: file, finishAfterFile: true)
        return try await results.value
    }

    /// As `DraftRelay.heard` makes a final: words timed in ms, untimed runs joined to the next word.
    static func heard(_ result: AttributedString, range: CMTimeRange) -> Heard {
        func ms(_ time: CMTime) -> Int64 { time.seconds.isFinite ? Int64(time.seconds * 1000) : 0 }
        var words: [HeardWord] = []
        var pending = ""
        for run in result.runs {
            let text = String(result[run.range].characters)
            guard let timed = run.audioTimeRange else {
                pending += text
                continue
            }
            words.append(HeardWord(text: pending + text, startMs: ms(timed.start), endMs: ms(timed.end)))
            pending = ""
        }
        if !pending.isEmpty, let last = words.popLast() {
            words.append(HeardWord(text: last.text + pending, startMs: last.startMs, endMs: last.endMs))
        }
        return Heard(
            text: String(result.characters), isFinal: true, startMs: ms(range.start), endMs: ms(range.end), words: words)
    }
}
