import AppKit
import CoreAudio
import Foundation

/// `--watch-mic`: reports which apps have the microphone open, so the app can
/// tell a call has started. One `mic` line at start and one on every change:
/// `{"event":"mic","precise":true,"apps":["us.zoom.xos"]}`. Exits when stdin
/// closes, so it never outlives the app.
///
/// On macOS 14.2 and later each process says whether it is taking input
/// (`precise`). Before that, macOS only says the microphone is in use by
/// someone, and `apps` is every app running while it is: the reader has to
/// narrow that down itself.
enum MicWatch {
    static let pollSeconds: TimeInterval = 2

    static func run() -> Never {
        let own = Set([getpid(), getppid()])
        var last: [String]?
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: pollSeconds)
        timer.setEventHandler {
            let (precise, apps) = current(excluding: own)
            if apps != last {
                last = apps
                EventEmitter.emit(["event": "mic", "precise": precise, "apps": apps])
            }
        }
        timer.resume()
        // The app closes our stdin when it quits or no longer wants reports.
        // Reading to the end blocks until then; the exit runs on the main queue,
        // between reports.
        DispatchQueue.global().async {
            _ = FileHandle.standardInput.readDataToEndOfFile()
            DispatchQueue.main.async { exit(0) }
        }
        RunLoop.main.run()
        exit(0)
    }

    /// Sorted bundle ids of the apps holding the microphone.
    static func current(excluding own: Set<pid_t>) -> (precise: Bool, apps: [String]) {
        if #available(macOS 14.2, *) {
            return (true, inputProcesses(excluding: own))
        }
        guard defaultInputIsRunning() else { return (false, []) }
        let running = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && !own.contains($0.processIdentifier) }
            .compactMap(\.bundleIdentifier)
        return (false, Array(Set(running)).sorted())
    }

    @available(macOS 14.2, *)
    private static func inputProcesses(excluding own: Set<pid_t>) -> [String] {
        var ids = Set<String>()
        for process in objects(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList) {
            guard uint32(process, kAudioProcessPropertyIsRunningInput) == 1 else { continue }
            if let pid = int32(process, kAudioProcessPropertyPID), own.contains(pid) { continue }
            if let id = string(process, kAudioProcessPropertyBundleID), !id.isEmpty { ids.insert(id) }
        }
        return ids.sorted()
    }

    private static func defaultInputIsRunning() -> Bool {
        var device = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = globalAddress(kAudioHardwarePropertyDefaultInputDevice)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
              device != 0
        else { return false }
        return uint32(device, kAudioDevicePropertyDeviceIsRunningSomewhere) == 1
    }

    private static func globalAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    private static func objects(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
        var address = globalAddress(selector)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    private static func uint32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var address = globalAddress(selector)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
    }

    private static func int32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Int32? {
        var address = globalAddress(selector)
        var value: Int32 = 0
        var size = UInt32(MemoryLayout<Int32>.size)
        return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
    }

    private static func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = globalAddress(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }
}
