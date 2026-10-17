import AVFoundation
import CoreGraphics
import Foundation
import Speech

private let PROMPT_TIMEOUT_SEC: Double =
    ProcessInfo.processInfo.environment["EAVESY_PREFLIGHT_TIMEOUT_SEC"]
    .flatMap(Double.init) ?? 120

enum Preflight {
    enum Prompt: String { case mic, speech, screen }

    /// Which permissions this run may ask for. `--request <mic|speech|screen>` asks for that one
    /// alone, so the app can put one macOS prompt on screen at a time; `--no-prompt` asks for none.
    static func prompts(_ arguments: [String]) -> Set<Prompt> {
        if arguments.contains("--no-prompt") { return [] }
        if let index = arguments.firstIndex(of: "--request") {
            guard index + 1 < arguments.count, let only = Prompt(rawValue: arguments[index + 1]) else { return [] }
            return [only]
        }
        var prompts: Set<Prompt> = [.mic]
        if arguments.contains("--need-screen") { prompts.insert(.screen) }
        if arguments.contains("--need-speech") { prompts.insert(.speech) }
        return prompts
    }

    static func status(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "notGranted"
        }
    }

    static func status(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "notGranted"
        }
    }

    static func run(arguments: [String]) -> Never {
        let prompts = prompts(arguments)
        let screenBefore = CGPreflightScreenCaptureAccess()
        if prompts.contains(.screen) && !screenBefore {
            _ = CGRequestScreenCaptureAccess()
        }

        let lock = NSLock()
        var mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        if prompts.contains(.mic) && AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            let semaphore = DispatchSemaphore(value: 0)
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                lock.lock()
                mic = granted
                lock.unlock()
                semaphore.signal()
            }
            _ = semaphore.wait(timeout: .now() + PROMPT_TIMEOUT_SEC)
        }
        lock.lock()
        let micGranted = mic
        lock.unlock()

        // Asked for here (setup, or turning captions on), never by a recording.
        if prompts.contains(.speech) && SFSpeechRecognizer.authorizationStatus() == .notDetermined
            && Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil
        {
            let semaphore = DispatchSemaphore(value: 0)
            SFSpeechRecognizer.requestAuthorization { _ in semaphore.signal() }
            _ = semaphore.wait(timeout: .now() + PROMPT_TIMEOUT_SEC)
        }

        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        EventEmitter.permissions(
            mic: micGranted,
            micAsked: micStatus != .notDetermined,
            screen: CGPreflightScreenCaptureAccess(),
            speech: speechStatus == .authorized,
            micStatus: status(micStatus),
            speechStatus: status(speechStatus))
        fflush(stdout)
        exit(0)
    }
}
