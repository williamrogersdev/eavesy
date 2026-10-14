import Foundation

enum EventEmitter {
    private static let lock = NSLock()

    private static func emit(_ object: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: object, options: [.sortedKeys])
        else { return }
        var line = data
        line.append(0x0A)
        FileHandle.standardOutput.write(line)
    }

    static func ready() {
        captureIsLive = true
        emit(["event": "ready"])
    }

    static func warning(_ message: String) {
        emit(["event": "warning", "message": message])
    }

    static func level(_ rms: Double) {
        let clamped = min(max(rms, 0.0), 1.0)
        emit(["event": "level", "rms": clamped])
    }

    static func error(_ message: String) {
        emit(["event": "error", "message": message])
    }

    /// A single segment could not be written. The capture and the archive carry on,
    /// so this must not be reported as `error`, which the host treats as fatal.
    static func segmentError(_ message: String) {
        emit(["event": "segment_error", "message": message])
    }

    static func segment(
        path: String, index: Int, track: String, startMs: Int64, durationMs: Int64,
        bytes: Int64, peakRms: Double, activeMs: Int64
    ) {
        emit([
            "event": "segment",
            "path": path,
            "index": index,
            "track": track,
            "startMs": startMs,
            "durationMs": durationMs,
            "bytes": bytes,
            "peakRms": peakRms,
            "activeMs": activeMs,
        ])
    }

    static func done(path: String, durationSec: Double) {
        emit(["event": "done", "path": path, "durationSec": durationSec])
    }

    static func permissions(mic: Bool, micAsked: Bool, screen: Bool) {
        emit(["event": "permissions", "mic": mic, "micAsked": micAsked, "screen": screen])
    }
}

var captureIsLive = false
var salvageAndExit: (() -> Void)?

func fail(_ message: String) -> Never {
    if captureIsLive, let salvage = salvageAndExit {
        EventEmitter.warning(message)
        DispatchQueue.global().asyncAfter(deadline: .now() + 15) { exit(1) }
        if Thread.isMainThread {
            salvage()
            while true { RunLoop.main.run(until: Date().addingTimeInterval(1)) }
        }
        DispatchQueue.main.async { salvage() }
        while true { sleep(1) }
    }
    EventEmitter.error(message)
    fflush(stdout)
    exit(1)
}
