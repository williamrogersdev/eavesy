import AVFoundation
import CoreGraphics
import Foundation

private let PROMPT_TIMEOUT_SEC: Double =
    ProcessInfo.processInfo.environment["EAVESY_PREFLIGHT_TIMEOUT_SEC"]
    .flatMap(Double.init) ?? 120

enum Preflight {
    static func run(needScreen: Bool, prompt: Bool) -> Never {
        let screenBefore = CGPreflightScreenCaptureAccess()
        if prompt && needScreen && !screenBefore {
            _ = CGRequestScreenCaptureAccess()
        }

        let lock = NSLock()
        var mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        if prompt && AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
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

        EventEmitter.permissions(
            mic: micGranted,
            micAsked: AVCaptureDevice.authorizationStatus(for: .audio) != .notDetermined,
            screen: CGPreflightScreenCaptureAccess())
        fflush(stdout)
        exit(0)
    }
}
