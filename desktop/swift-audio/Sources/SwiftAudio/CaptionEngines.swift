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
        preview: Bool = true,
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
                        switch await AnalyzerEngine.make(locale: locale, vocabulary: vocabulary, preview: preview) {
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
    // A rolled-over request still owns words. Keep its window alive until
    // its final callback; the task callback deliberately captures it weakly.
    private var drainingWindows: [Window] = []
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
        drainingWindows.append(window)
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
        if current === window { current = nil }
        drainingWindows.removeAll { $0 === window }
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
    /// Apple's on-device speech models for SpeechAnalyzer. A model on disk is
    /// only usable once the app has reserved its language, so Eavesy reserves
    /// it itself and fetches what is missing: nobody installs anything by hand.
    @available(macOS 26.0, *)
    enum SpeechModels {
        enum State: String { case installed, downloading, unsupported }

        static func prepare(_ transcribers: [SpeechTranscriber], locale: Locale, wait: Bool) async -> State {
            await reserve(locale)
            switch await AssetInventory.status(forModules: transcribers) {
            case .installed:
                return .installed
            case .unsupported:
                return .unsupported
            default:
                let install = installing(transcribers, locale: locale)
                guard wait else { return .downloading }
                await install.value
                return await AssetInventory.status(forModules: transcribers) == .installed ? .installed : .downloading
            }
        }

        private static let lock = NSLock()
        nonisolated(unsafe) private static var inFlight: [String: Task<Void, Never>] = [:]

        /// One download per language at a time, however many recordings ask.
        private static func installing(_ transcribers: [SpeechTranscriber], locale: Locale) -> Task<Void, Never> {
            let key = locale.identifier(.bcp47)
            lock.lock()
            defer { lock.unlock() }
            if let running = inFlight[key] { return running }
            let task = Task.detached {
                do {
                    try await AssetInventory.assetInstallationRequest(supporting: transcribers)?.downloadAndInstall()
                } catch {
                    EventEmitter.warning("speech model for \(locale.identifier) did not install: \(error.localizedDescription)")
                }
                lock.withLock { inFlight[key] = nil }
            }
            inFlight[key] = task
            return task
        }

        /// Reserves `locale`, letting go of the oldest other reservation when
        /// the system's limit is reached.
        private static func reserve(_ locale: Locale) async {
            let reserved = await AssetInventory.reservedLocales
            if reserved.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) { return }
            if reserved.count >= AssetInventory.maximumReservedLocales, let oldest = reserved.first {
                _ = await AssetInventory.release(reservedLocale: oldest)
            }
            do {
                _ = try await AssetInventory.reserve(locale: locale)
            } catch {
                EventEmitter.warning("speech model for \(locale.identifier) not reserved: \(error.localizedDescription)")
            }
        }
    }

    /// macOS 26 SpeechAnalyzer + SpeechTranscriber: on-device, volatile results
    /// within a few seconds, finals as it settles phrases. Times come back on
    /// the recording clock, shifted by where the first buffer started.
    ///
    /// Two analyzers hear the same audio. The accurate one gives every final;
    /// it reports in steps of about four seconds, so the first words would
    /// show four seconds late. The preview one uses `.fastResults`, which
    /// reports every second but drops and garbles words, so it only fills in
    /// the HUD past what the accurate one has heard (see `LiveDraft`). They
    /// can't share one analyzer: modules in one analyzer all get the same
    /// results, in whichever mode it picks, which made the finals fast-mode
    /// text in some runs. Two analyzers in one process still nudge each
    /// other: with the preview running, the accurate one sometimes settles a
    /// phrase differently (joins two sentences, spells a rare name another
    /// way), though its finals are never the preview's text. The preview is
    /// best effort: if it fails or falls behind, captions carry on with the
    /// accurate one alone.
    @available(macOS 26.0, *)
    final class AnalyzerEngine: SpeechEngine {
        let name = "speech-analyzer"
        private let transcriber: SpeechTranscriber
        /// Nil when the setting for faster live words is off.
        private let previewer: SpeechTranscriber?
        private let vocabulary: [String]
        private let format: AVAudioFormat
        private var analyzer: SpeechAnalyzer?
        private var previewAnalyzer: SpeechAnalyzer?
        private var converter: AVAudioConverter?
        private let input: AsyncStream<AnalyzerInput>
        private let feed: AsyncStream<AnalyzerInput>.Continuation
        private let previewInput: AsyncStream<AnalyzerInput>
        private var results: Task<Void, Never>?
        private var running: Task<Void, Never>?
        private let relay: DraftRelay

        /// The accurate transcriber and the preview one, for `locale`. Both
        /// use the same model, so preparing either covers it.
        static func transcribers(locale: Locale) -> [SpeechTranscriber] {
            [
                SpeechTranscriber(
                    locale: locale,
                    transcriptionOptions: [],
                    // No `.fastResults`: it drops and garbles words to show them a
                    // few seconds sooner, and these finals are what dictation pastes.
                    reportingOptions: [.volatileResults],
                    attributeOptions: [.audioTimeRange]),
                SpeechTranscriber(
                    locale: locale,
                    transcriptionOptions: [],
                    reportingOptions: [.volatileResults, .fastResults],
                    attributeOptions: [.audioTimeRange]),
            ]
        }

        static func make(
            locale: Locale, vocabulary: [String], preview: Bool = true
        ) async -> Result<SpeechEngine, CaptionUnavailable> {
            guard SpeechTranscriber.isAvailable else {
                return .failure(CaptionUnavailable(reason: "transcriber unavailable on this Mac"))
            }
            guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
                return .failure(CaptionUnavailable(reason: "locale \(locale.identifier) unsupported"))
            }
            let transcribers = Array(Self.transcribers(locale: supported).prefix(preview ? 2 : 1))
            switch await SpeechModels.prepare(transcribers, locale: supported, wait: false) {
            case .installed:
                break
            case .unsupported:
                return .failure(CaptionUnavailable(reason: "no model for \(supported.identifier)"))
            case .downloading:
                // This recording falls back; the download carries on for next time.
                return .failure(CaptionUnavailable(reason: "model for \(supported.identifier) downloading"))
            }
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: transcribers) else {
                return .failure(CaptionUnavailable(reason: "no compatible audio format"))
            }
            return .success(
                AnalyzerEngine(
                    transcriber: transcribers[0], previewer: transcribers.dropFirst().first, vocabulary: vocabulary,
                    format: format))
        }

        private init(
            transcriber: SpeechTranscriber, previewer: SpeechTranscriber?, vocabulary: [String], format: AVAudioFormat
        ) {
            self.transcriber = transcriber
            self.previewer = previewer
            self.vocabulary = vocabulary
            self.format = format
            (input, feed) = AsyncStream.makeStream(of: AnalyzerInput.self, bufferingPolicy: .bufferingNewest(500))
            let (previewInput, previewFeed) = AsyncStream.makeStream(
                of: AnalyzerInput.self, bufferingPolicy: .bufferingNewest(500))
            self.previewInput = previewInput
            relay = DraftRelay(previewFeed: previewFeed)
        }

        func start(sink: CaptionSink) throws {
            relay.sink = sink
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            self.analyzer = analyzer
            converter = AVAudioConverter(from: AudioRecorder.mixFormat, to: format)
            let relay = self.relay
            let transcriber = self.transcriber
            results = Task {
                do {
                    for try await result in transcriber.results {
                        let heard = relay.heard(result)
                        relay.update { $0.accurate(heard) }
                    }
                } catch {
                    relay.sink?.engineFailed(error.localizedDescription)
                }
            }
            let input = self.input
            let vocabulary = self.vocabulary
            let startPreview = preview()
            running = Task {
                do {
                    try await Self.apply(vocabulary, to: analyzer)
                    try await analyzer.start(inputSequence: input)
                } catch {
                    relay.sink?.engineFailed(error.localizedDescription)
                    return
                }
                await startPreview()
            }
        }

        /// The preview analyzer, beside the accurate one; what it returns
        /// starts it, once the accurate one has. Its failures only end the
        /// preview.
        private func preview() -> () async -> Void {
            guard let previewer else {
                relay.endPreview(nil)
                return {}
            }
            let analyzer = SpeechAnalyzer(modules: [previewer])
            previewAnalyzer = analyzer
            let relay = self.relay
            Task {
                do {
                    for try await result in previewer.results {
                        let heard = relay.heard(result)
                        relay.update { $0.fast(heard) }
                    }
                } catch {
                    relay.endPreview("live preview failed: \(error.localizedDescription)")
                }
            }
            let input = previewInput
            let vocabulary = self.vocabulary
            return {
                do {
                    try await Self.apply(vocabulary, to: analyzer)
                    try await analyzer.start(inputSequence: input)
                } catch {
                    relay.endPreview("live preview did not start: \(error.localizedDescription)")
                }
            }
        }

        private static func apply(_ vocabulary: [String], to analyzer: SpeechAnalyzer) async throws {
            guard !vocabulary.isEmpty else { return }
            let context = AnalysisContext()
            context.contextualStrings[.general] = vocabulary
            do {
                try await analyzer.setContext(context)
            } catch {
                EventEmitter.warning("custom words not applied: \(error.localizedDescription)")
            }
        }

        func append(_ buffer: AVAudioPCMBuffer, atMs: Int64) throws {
            guard let converted = convert(buffer) else {
                relay.sink?.audioDropped(1)
                return
            }
            relay.noteStart(atMs)
            // A recognizer that falls behind loses the oldest audio here: say
            // so, or its text looks whole while missing what was said first.
            if case .dropped = feed.yield(AnalyzerInput(buffer: converted)) {
                relay.sink?.audioDropped(1)
            }
            relay.preview(converted)
        }

        func finish(_ done: @escaping () -> Void) {
            // What is pasted at Stop must be the accurate text alone.
            relay.endPreview(nil)
            feed.finish()
            let analyzer = self.analyzer
            let previewAnalyzer = self.previewAnalyzer
            let running = self.running
            let results = self.results
            let relay = self.relay
            Task {
                await previewAnalyzer?.cancelAndFinishNow()
            }
            Task {
                await running?.value
                try? await analyzer?.finalizeAndFinishThroughEndOfInput()
                await results?.value
                relay.drain()
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

    /// What both analyzers' result tasks share, kept apart from the engine so
    /// a replaced engine's last finals still arrive: the sink, the clock
    /// offset, the preview's feed and the `LiveDraft` merging the two.
    ///
    /// Results are merged and sent on a queue of its own, so neither result
    /// loop ever waits on the other's work.
    @available(macOS 26.0, *)
    private final class DraftRelay: @unchecked Sendable {
        weak var sink: CaptionSink?
        private let lock = NSLock()
        private let queue = DispatchQueue(label: "com.eavesy.swiftaudio.captions.draft")
        /// Only touched on `queue`.
        private var draft = LiveDraft()
        private var previewFeed: AsyncStream<AnalyzerInput>.Continuation?
        /// Where on the recording clock the first buffer fed in starts. The
        /// analyzers are fed contiguous audio without timestamps (stamped input
        /// fails as soon as a converted buffer's length rounds past the next
        /// stamp) and their times are shifted by this.
        private var offsetMs: Int64?

        init(previewFeed: AsyncStream<AnalyzerInput>.Continuation) {
            self.previewFeed = previewFeed
        }

        func noteStart(_ atMs: Int64) {
            lock.withLock {
                if offsetMs == nil { offsetMs = atMs }
            }
        }

        /// The preview gets the same audio. Its losses are not counted:
        /// nothing it hears is kept. One that loses audio would misplace its
        /// words, so the preview ends there.
        func preview(_ buffer: AVAudioPCMBuffer) {
            let feed = lock.withLock { previewFeed }
            if case .dropped = feed?.yield(AnalyzerInput(buffer: buffer)) {
                endPreview("live preview fell behind")
            }
        }

        /// Back to the accurate text alone; `reason` is why, when it failed.
        func endPreview(_ reason: String?) {
            let feed = lock.withLock {
                let feed = previewFeed
                previewFeed = nil
                return feed
            }
            feed?.finish()
            if let reason, feed != nil { FileHandle.standardError.write(Data("\(reason)\n".utf8)) }
            update { $0.stopPreview() }
        }

        /// Sends what changed, in order: results from the two analyzers
        /// arrive on separate tasks.
        func update(_ change: @escaping (inout LiveDraft) -> [DraftCaption]) {
            queue.async { [self] in
                for caption in change(&draft) {
                    sink?.recognized(
                        text: caption.text, isFinal: caption.isFinal, startMs: caption.startMs, endMs: caption.endMs,
                        preview: caption.preview)
                }
            }
        }

        /// Returns once everything already received has been sent.
        func drain() {
            queue.sync {}
        }

        func heard(_ result: SpeechTranscriber.Result) -> Heard {
            let offset = lock.withLock { offsetMs ?? 0 }
            func ms(_ time: CMTime) -> Int64 {
                offset + (time.seconds.isFinite ? Int64(time.seconds * 1000) : 0)
            }
            var words: [HeardWord] = []
            if result.isFinal {
                // Untimed runs (spacing, punctuation) go with the next timed word.
                var pending = ""
                for run in result.text.runs {
                    let text = String(result.text[run.range].characters)
                    guard let range = run.audioTimeRange else {
                        pending += text
                        continue
                    }
                    words.append(HeardWord(text: pending + text, startMs: ms(range.start), endMs: ms(range.end)))
                    pending = ""
                }
                if !pending.isEmpty, let last = words.popLast() {
                    words.append(HeardWord(text: last.text + pending, startMs: last.startMs, endMs: last.endMs))
                }
            }
            return Heard(
                text: String(result.text.characters), isFinal: result.isFinal,
                startMs: ms(result.range.start), endMs: ms(result.range.end), words: words)
        }
    }
#endif
