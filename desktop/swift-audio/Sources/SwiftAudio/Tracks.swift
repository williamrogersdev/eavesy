import Foundation

enum Track: String, CaseIterable {
    case mic
    case system
}

struct SplitChunk {
    let mix: [Float]
    let mic: [Float]
    let system: [Float]
}

func splitChunk(system: [Float], mic: [Float]) -> SplitChunk {
    let count = system.count
    var micTrack = Array(mic.prefix(count))
    if micTrack.count < count {
        micTrack.append(contentsOf: repeatElement(0, count: count - micTrack.count))
    }
    var mix = [Float](repeating: 0, count: count)
    for i in 0..<count {
        mix[i] = min(max(system[i] + micTrack[i], -1), 1)
    }
    return SplitChunk(mix: mix, mic: micTrack, system: system)
}

struct TrackLevel {
    static let frameSamples = 1_440
    static let activeThreshold = 0.01

    private(set) var peakRms = 0.0
    private(set) var activeFrames = 0
    private var partial: [Float] = []

    var activeMs: Int64 { Int64(activeFrames * 30) }

    mutating func observe(_ samples: [Float]) {
        partial.append(contentsOf: samples)
        var offset = 0
        while partial.count - offset >= Self.frameSamples {
            var sum = 0.0
            for i in offset..<(offset + Self.frameSamples) {
                let v = Double(partial[i])
                sum += v * v
            }
            let rms = (sum / Double(Self.frameSamples)).squareRoot()
            peakRms = max(peakRms, rms)
            if rms >= Self.activeThreshold { activeFrames += 1 }
            offset += Self.frameSamples
        }
        if offset > 0 { partial.removeFirst(offset) }
    }
}
