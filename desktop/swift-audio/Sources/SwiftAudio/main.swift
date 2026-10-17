import Foundation

setvbuf(stdout, nil, _IONBF, 0)

if CommandLine.arguments.contains("--preflight") {
    Preflight.run(arguments: CommandLine.arguments)
}

if let index = CommandLine.arguments.firstIndex(of: "--screenshot"), index + 1 < CommandLine.arguments.count {
    Screenshot.run(outPath: CommandLine.arguments[index + 1])
}

let args = Arguments.parse(CommandLine.arguments)

let captions = Dictionary(
    uniqueKeysWithValues: args.captions.map { track in
        (
            track,
            LiveCaptions(track: track.rawValue, emit: EventEmitter.emit) { ready in
                CaptionEngines.make(locale: args.locale, completion: ready)
            }
        )
    })

let recorder: Recorder
switch args.mode {
case .audio:
    recorder = AudioRecorder(
        outPath: args.outPath,
        source: args.source,
        segmentDir: args.segmentDir,
        segmentSec: args.segmentSec,
        captions: captions)
case .screen:
    recorder = ScreenRecorder(outPath: args.outPath, includeMic: args.includeMic)
}

let stopLock = NSLock()
var didStop = false

func gracefulStop() {
    stopLock.lock()
    if didStop {
        stopLock.unlock()
        return
    }
    didStop = true
    stopLock.unlock()

    recorder.stop { durationSec in
        EventEmitter.done(path: args.outPath, durationSec: durationSec)
        fflush(stdout)
        exit(0)
    }
}

func installSignalHandler(_ sig: Int32) {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        gracefulStop()
    }
    source.resume()
    signalSources.append(source)
}

salvageAndExit = gracefulStop

var signalSources: [DispatchSourceSignal] = []
installSignalHandler(SIGINT)
installSignalHandler(SIGTERM)

let stdinThread = Thread {
    let handle = FileHandle.standardInput
    var buffer = Data()
    while true {
        let chunk = handle.availableData
        if chunk.isEmpty {
            gracefulStop()
            break
        }
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            let line = String(decoding: lineData, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if line == "stop" {
                gracefulStop()
                return
            }
        }
    }
}
stdinThread.stackSize = 1 << 20
stdinThread.start()

recorder.start()

RunLoop.main.run()
