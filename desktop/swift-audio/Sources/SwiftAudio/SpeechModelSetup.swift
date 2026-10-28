import Foundation
import Speech

/// `--prepare-speech [--language <code|auto>]`: gets the on-device speech
/// model for the caption language ready ahead of the first recording, so
/// captions and the quick dictation paste use the best engine from the start.
/// Prints one `speech_model` line and exits.
enum SpeechModelSetup {
    /// How long the custom-word model may take to download before this exits.
    static let spellerWaitSec: Double = 600

    static func run(arguments: [String]) -> Never {
        var language: String?
        if let index = arguments.firstIndex(of: "--language"), index + 1 < arguments.count {
            language = arguments[index + 1]
        }
        let locale =
            language?.lowercased() == CaptionLanguage.auto || language == nil
            ? Locale.current
            : Arguments.captionLocale(language: language, current: Locale.current, supported: CaptionLanguage.supportedLocales())
        let semaphore = DispatchSemaphore(value: 0)
        let spelling = DispatchSemaphore(value: 0)
        var state = "unsupported"
        var spells = false
        Task {
            #if compiler(>=6.2)
                if #available(macOS 26.0, *), SpeechTranscriber.isAvailable,
                    let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale)
                {
                    state = await SpeechModels.prepare(
                        AnalyzerEngine.transcribers(locale: supported), locale: supported, wait: true
                    ).rawValue
                    semaphore.signal()
                    // Dictation's custom-word model too, best effort.
                    spells = await AnalyzerEngine.speller(locale: supported, wait: true) != nil
                    spelling.signal()
                    return
                }
            #endif
            semaphore.signal()
            spelling.signal()
        }
        semaphore.wait()
        EventEmitter.emit(["event": "speech_model", "locale": locale.identifier, "state": state])
        fflush(stdout)
        let settled = spelling.wait(timeout: .now() + spellerWaitSec) == .success
        FileHandle.standardError.write(
            Data("custom-word model: \(settled ? (spells ? "installed" : "unavailable") : "still downloading")\n".utf8))
        exit(0)
    }
}
