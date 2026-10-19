import AVFoundation
import Foundation
import Speech

/// Picks the best on-device recognizer for a locale: SpeechAnalyzer where the
/// OS and its model are ready, otherwise SFSpeechRecognizer forced on-device.
/// Never prompts: Speech Recognition is asked for up front (setup, or turning
/// captions on, through `--preflight --need-speech`), so a recording that has
/// no answer yet simply runs without captions.
enum CaptionEngines {
    static func make(
        locale: Locale,
        vocabulary: [String] = [],
        completion: @escaping (Result<SpeechEngine, CaptionUnavailable>) -> Void
    ) {
        // Asking without a usage description kills the process (TCC), so check first.
        guard Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil else {
            completion(.failure(CaptionUnavailable(reason: "speech recognition usage description missing")))
            return
        }
        authorize { authorized in
            // Both engines are speech recognition as far as the user is
            // concerned, so neither runs without their permission.
            guard authorized else {
                completion(.failure(CaptionUnavailable(reason: "speech recognition not authorized")))
                return
            }
            Task {
                #if compiler(>=6.2)
                    if #available(macOS 26.0, *) {
                        switch await AnalyzerEngine.make(locale: locale, vocabulary: vocabulary) {
                        case .success(let engine):
                            completion(.success(engine))
                            return
                        case .failure(let unavailable):
                            EventEmitter.warning("speech analyzer unavailable: \(unavailable.reason)")
                        }
                    }
                #endif
                completion(SFSpeechEngine.make(locale: locale, vocabulary: vocabulary))
            }
        }
    }

    private static func authorize(_ next: @escaping (Bool) -> Void) {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            next(true)
        default:
            next(false)
        }
    }
}

/// SFSpeechRecognizer with on-device recognition required. A request only
/// settles its text when its audio ends, so the request is rolled over after
/// `rolloverMs` of audio to turn partials into finals as the recording goes.
/// It rolls over at the next pause, so no word is cut in half, and at
/// `rolloverCapMs` whatever is being said.
final class SFSpeechEngine: SpeechEngine {
    static let rolloverMs: Int64 = 30_000
    static let rolloverCapMs: Int64 = 45_000
    /// How long the audio has to stay below `pauseRms` to count as a pause.
    static let pauseMs: Int64 = 250
    static let pauseRms: Float = 0.01

    let name = "sfspeech"
    private let recognizer: SFSpeechRecognizer
    private let vocabulary: [String]
    private let lock = NSLock()
    private weak var sink: CaptionSink?
    private var current: Window?
    private var finishing: (() -> Void)?
    private var open = 0

    private final class Window {
        let request = SFSpeechAudioBufferRecognitionRequest()
        var task: SFSpeechRecognitionTask?
        let startMs: Int64
        var lastMs: Int64
        var quietMs: Int64 = 0
        var settled = false

        init(startMs: Int64, vocabulary: [String]) {
            self.startMs = startMs
            self.lastMs = startMs
            request.contextualStrings = vocabulary
            request.requiresOnDeviceRecognition = true
            request.shouldReportPartialResults = true
            request.addsPunctuation = true
            request.taskHint = .dictation
        }
    }

    static func make(locale: Locale, vocabulary: [String] = []) -> Result<SpeechEngine, CaptionUnavailable> {
        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            return .failure(CaptionUnavailable(reason: "no recognizer for \(locale.identifier)"))
        }
        guard recognizer.supportsOnDeviceRecognition else {
            return .failure(CaptionUnavailable(reason: "on-device recognition unsupported for \(locale.identifier)"))
        }
        return .success(SFSpeechEngine(recognizer: recognizer, vocabulary: vocabulary))
    }

    private init(recognizer: SFSpeechRecognizer, vocabulary: [String]) {
        self.recognizer = recognizer
        self.vocabulary = vocabulary
    }

    func start(sink: CaptionSink) throws {
        self.sink = sink
    }

    func append(_ buffer: AVAudioPCMBuffer, atMs: Int64) throws {
        lock.lock()
        defer { lock.unlock() }
        let window = current ?? openWindow(atMs: atMs)
        window.request.append(buffer)
        let durationMs = Int64(Double(buffer.frameLength) / buffer.format.sampleRate * 1000)
        window.lastMs = atMs + durationMs
        window.quietMs = Self.rms(buffer) < Self.pauseRms ? window.quietMs + durationMs : 0
        if Self.rollsOver(elapsedMs: window.lastMs - window.startMs, quietMs: window.quietMs) {
            window.request.endAudio()
            current = nil
        }
    }

    static func rollsOver(elapsedMs: Int64, quietMs: Int64) -> Bool {
        elapsedMs >= rolloverCapMs || (elapsedMs >= rolloverMs && quietMs >= pauseMs)
    }

    /// Audio it can't measure counts as loud, so it never passes for a pause.
    /// An empty buffer counts as quiet: it adds no time, so it can't end one either.
    static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        guard buffer.frameLength > 0 else { return 0 }
        guard let samples = buffer.floatChannelData?[0] else { return 1 }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) {
            sum += samples[i] * samples[i]
        }
        return (sum / Float(buffer.frameLength)).squareRoot()
    }

    func finish(_ done: @escaping () -> Void) {
        lock.lock()
        current?.request.endAudio()
        current = nil
        if open == 0 {
            lock.unlock()
            done()
            return
        }
        finishing = done
        lock.unlock()
    }

    /// Called with `lock` held.
    private func openWindow(atMs: Int64) -> Window {
        let window = Window(startMs: atMs, vocabulary: vocabulary)
        open += 1
        window.task = recognizer.recognitionTask(with: window.request) { [weak self, weak window] result, error in
            guard let self, let window else { return }
            self.handle(window: window, result: result, error: error)
        }
        current = window
        return window
    }

    private func handle(window: Window, result: SFSpeechRecognitionResult?, error: Error?) {
        if let result {
            let text = result.bestTranscription.formattedString
            let segments = result.bestTranscription.segments
            let startMs = window.startMs + Int64((segments.first?.timestamp ?? 0) * 1000)
            let endMs =
                segments.last.map { window.startMs + Int64(($0.timestamp + $0.duration) * 1000) }
                ?? window.lastMs
            sink?.recognized(text: text, isFinal: result.isFinal, startMs: startMs, endMs: max(endMs, startMs))
        }
        if let error, !Self.isBenign(error) {
            sink?.engineFailed(error.localizedDescription)
        }
        if result?.isFinal == true || error != nil {
            settle(window)
        }
    }

    private func settle(_ window: Window) {
        lock.lock()
        guard !window.settled else {
            lock.unlock()
            return
        }
        window.settled = true
        open -= 1
        let done = open == 0 ? finishing : nil
        if done != nil { finishing = nil }
        lock.unlock()
        done?()
    }

    /// "No speech detected" and cancellation end a window without anything wrong.
    static func isBenign(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == "kAFAssistantErrorDomain" && [203, 216, 1110].contains(ns.code)
            || ns.domain == NSCocoaErrorDomain && ns.code == NSUserCancelledError
    }
}

#if compiler(>=6.2)
    /// macOS 26 SpeechAnalyzer + SpeechTranscriber: on-device, volatile results
    /// within a few hundred ms, finals as it settles phrases. Times come back on
    /// the recording clock because every buffer is stamped with its offset.
    @available(macOS 26.0, *)
    final class AnalyzerEngine: SpeechEngine {
        let name = "speech-analyzer"
        private let transcriber: SpeechTranscriber
        private let vocabulary: [String]
        private let format: AVAudioFormat
        private var analyzer: SpeechAnalyzer?
        private var converter: AVAudioConverter?
        private let input: AsyncStream<AnalyzerInput>
        private let feed: AsyncStream<AnalyzerInput>.Continuation
        private var results: Task<Void, Never>?
        private var running: Task<Void, Never>?

        static func make(locale: Locale, vocabulary: [String]) async -> Result<SpeechEngine, CaptionUnavailable> {
            guard SpeechTranscriber.isAvailable else {
                return .failure(CaptionUnavailable(reason: "transcriber unavailable on this Mac"))
            }
            guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
                return .failure(CaptionUnavailable(reason: "locale \(locale.identifier) unsupported"))
            }
            let transcriber = SpeechTranscriber(
                locale: supported,
                transcriptionOptions: [],
                reportingOptions: [.volatileResults, .fastResults],
                attributeOptions: [.audioTimeRange])
            switch await AssetInventory.status(forModules: [transcriber]) {
            case .installed:
                break
            case .unsupported:
                return .failure(CaptionUnavailable(reason: "no model for \(supported.identifier)"))
            default:
                // Fetch it for next time; this recording falls back.
                Task.detached {
                    try? await AssetInventory.assetInstallationRequest(supporting: [transcriber])?
                        .downloadAndInstall()
                }
                return .failure(CaptionUnavailable(reason: "model for \(supported.identifier) downloading"))
            }
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
                return .failure(CaptionUnavailable(reason: "no compatible audio format"))
            }
            return .success(AnalyzerEngine(transcriber: transcriber, vocabulary: vocabulary, format: format))
        }

        private init(transcriber: SpeechTranscriber, vocabulary: [String], format: AVAudioFormat) {
            self.transcriber = transcriber
            self.vocabulary = vocabulary
            self.format = format
            (input, feed) = AsyncStream.makeStream(of: AnalyzerInput.self, bufferingPolicy: .bufferingNewest(500))
        }

        func start(sink: CaptionSink) throws {
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            self.analyzer = analyzer
            converter = AVAudioConverter(from: AudioRecorder.mixFormat, to: format)
            let transcriber = self.transcriber
            results = Task { [weak sink] in
                do {
                    for try await result in transcriber.results {
                        let start = result.range.start.seconds
                        let end = result.range.end.seconds
                        sink?.recognized(
                            text: String(result.text.characters),
                            isFinal: result.isFinal,
                            startMs: start.isFinite ? Int64(start * 1000) : 0,
                            endMs: end.isFinite ? Int64(end * 1000) : 0)
                    }
                } catch {
                    sink?.engineFailed(error.localizedDescription)
                }
            }
            let input = self.input
            let vocabulary = self.vocabulary
            running = Task { [weak sink] in
                do {
                    if !vocabulary.isEmpty {
                        let context = AnalysisContext()
                        context.contextualStrings[.general] = vocabulary
                        try? await analyzer.setContext(context)
                    }
                    try await analyzer.start(inputSequence: input)
                } catch {
                    sink?.engineFailed(error.localizedDescription)
                }
            }
        }

        func append(_ buffer: AVAudioPCMBuffer, atMs: Int64) throws {
            guard let converted = convert(buffer) else { return }
            feed.yield(AnalyzerInput(buffer: converted, bufferStartTime: CMTime(value: atMs, timescale: 1000)))
        }

        func finish(_ done: @escaping () -> Void) {
            feed.finish()
            let analyzer = self.analyzer
            let running = self.running
            let results = self.results
            Task {
                await running?.value
                try? await analyzer?.finalizeAndFinishThroughEndOfInput()
                await results?.value
                done()
            }
        }

        private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
            if buffer.format == format { return buffer }
            guard let converter else { return nil }
            let ratio = format.sampleRate / buffer.format.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1)
            guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
            var fed = false
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, status in
                if fed {
                    status.pointee = .noDataNow
                    return nil
                }
                fed = true
                status.pointee = .haveData
                return buffer
            }
            guard status != .error, error == nil else { return nil }
            return out
        }
    }
#endif
