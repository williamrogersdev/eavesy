import Foundation

setvbuf(stdout, nil, _IONBF, 0)
StartClock.mark()

if CommandLine.arguments.contains("--preflight") {
    Preflight.run(arguments: CommandLine.arguments)
}

if let index = CommandLine.arguments.firstIndex(of: "--screenshot"), index + 1 < CommandLine.arguments.count {
    Screenshot.run(outPath: CommandLine.arguments[index + 1])
}

let stdinLines = LineReader(handle: .standardInput)

// A standby is launched ahead of the hotkey and waits, microphone closed, for
// the arguments a cold launch would have had.
var micWarmup: MicWarmup?
let argv: [String]
if CommandLine.arguments.contains("--standby") {
    micWarmup = MicWarmup.prepare()
    FileHandle.standardError.write(Data(
        "standby: ready in \(StartClock.ms()) ms (mic session prepared: \(micWarmup != nil))\n".utf8))
    guard let start = Standby.awaitStart(stdinLines) else { exit(0) }
    StartClock.mark()
    argv = [CommandLine.arguments[0]] + start
} else {
    argv = CommandLine.arguments
}

let args = Arguments.parse(argv)

let languages = CaptionLanguages(locale: args.locale, follows: args.followsSpeech, vocabulary: args.vocabulary)
let captions = Dictionary(
    uniqueKeysWithValues: args.captions.map { track in
        (
            track,
            LiveCaptions(track: track.rawValue, emit: EventEmitter.emit, onFinal: languages.heard) { ready in
                CaptionEngines.make(locale: args.locale, vocabulary: args.vocabulary, completion: ready)
            }
        )
    })
languages.captions = Array(captions.values)

let recorder: Recorder
switch args.mode {
case .audio:
    recorder = AudioRecorder(
        outPath: args.outPath,
        source: args.source,
        segmentDir: args.segmentDir,
        segmentSec: args.segmentSec,
        captions: captions,
        micWarmup: micWarmup)
case .screen:
    recorder = ScreenRecorder(outPath: args.outPath, includeMic: args.includeMic)
}
// The recorder holds the prepared session if it can use it; let go of it here.
micWarmup = nil

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
    while let line = stdinLines.next() {
        if line == "stop" { break }
        if let language = CaptionLanguage.hint(line) { languages.cloudHeard(language) }
    }
    gracefulStop()
}
stdinThread.stackSize = 1 << 20
stdinThread.start()

recorder.start()

RunLoop.main.run()
