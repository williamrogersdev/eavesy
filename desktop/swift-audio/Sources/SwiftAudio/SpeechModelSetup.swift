import Foundation
import Speech

/// `--prepare-speech [--language <code|auto>]`: gets the on-device speech
/// model for the caption language ready ahead of the first recording, so
/// captions and the quick dictation paste use the best engine from the start.
/// Prints one `speech_model` line and exits.
enum SpeechModelSetup {
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
        var state = "unsupported"
        Task {
            #if compiler(>=6.2)
                if #available(macOS 26.0, *), SpeechTranscriber.isAvailable,
                    let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale)
                {
                    state = await SpeechModels.prepare(
                        AnalyzerEngine.transcribers(locale: supported), locale: supported, wait: true
                    ).rawValue
                }
            #endif
            semaphore.signal()
        }
        semaphore.wait()
        EventEmitter.emit(["event": "speech_model", "locale": locale.identifier, "state": state])
        fflush(stdout)
        exit(0)
    }
}
