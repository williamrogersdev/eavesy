import Accelerate
import XCTest

@testable import SwiftAudio

final class EchoCancellerTests: XCTestCase {
    private static let rate = 48_000

    private struct Noise {
        var state: UInt64
        mutating func next() -> Float {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Float(Int64(state >> 33) % 2_000_001) / 1_000_000 - 1
        }
    }

    /// Bursts of low-passed noise with pauses, loud and quiet like speech.
    private func voice(seconds: Int, seed: UInt64) -> [Float] {
        var noise = Noise(state: seed)
        var low: Float = 0
        var level: Float = 0
        return (0..<(seconds * Self.rate)).map { index in
            if index % 9_600 == 0 { level = abs(noise.next()) < 0.25 ? 0 : 0.2 + 0.6 * abs(noise.next()) }
            low += 0.2 * (noise.next() - low)
            return 0.6 * level * low
        }
    }

    /// What a microphone hears of `far`: a first arrival and a decaying room.
    private func echo(of far: [Float], delay: Int, driftPerMillion: Double = 0) -> [Float] {
        var noise = Noise(state: 7)
        var room = (0..<1_440).map { tap in tap < 30 ? 0 : 0.03 * noise.next() * exp(-Float(tap) / 400) }
        room[20] = 0.3
        var heard = [Float](repeating: 0, count: far.count)
        let padded = [Float](repeating: 0, count: room.count - 1) + far
        vDSP_conv(padded, 1, Array(room.reversed()), 1, &heard, 1, vDSP_Length(far.count), vDSP_Length(room.count))
        return heard.indices.map { index in
            let at = Double(index) * (1 + driftPerMillion * 1e-6) - Double(delay)
            let whole = Int(at.rounded(.down))
            guard whole >= 0, whole + 1 < heard.count else { return 0 }
            let part = Float(at - Double(whole))
            return heard[whole] * (1 - part) + heard[whole + 1] * part
        }
    }

    private func run(far: [Float], mic: [Float], canceller: EchoCanceller = EchoCanceller()) -> [Float] {
        var out: [Float] = []
        for start in stride(from: 0, to: far.count - 959, by: 960) {
            out += canceller.process(reference: Array(far[start..<(start + 960)]), mic: Array(mic[start..<(start + 960)]))
        }
        return out
    }

    private func decibels(_ samples: ArraySlice<Float>) -> Float {
        10 * log10(samples.reduce(0) { $0 + $1 * $1 } / Float(samples.count) + 1e-12)
    }

    /// What is left of `wanted` in the output from `from` seconds on, and how
    /// loud everything else in the output is.
    private func left(in out: [Float], besides wanted: [Float], from: Int, to: Int) -> Float {
        let range = (from * Self.rate)..<(to * Self.rate)
        let extra = range.map { out[$0 + EchoCanceller.latency] - wanted[$0] }
        return decibels(extra[...])
    }

    func testTheFarSideIsTakenOutOfTheMicrophone() {
        let far = voice(seconds: 14, seed: 1)
        let heard = echo(of: far, delay: 14_400)
        let out = run(far: far, mic: heard)

        let silence = [Float](repeating: 0, count: far.count)
        let range = (10 * Self.rate)..<(13 * Self.rate)
        XCTAssertLessThan(left(in: out, besides: silence, from: 10, to: 13), decibels(heard[range]) - 20)
    }

    func testTheUsersOwnVoiceComesThroughUntouched() {
        let far = voice(seconds: 16, seed: 1)
        var own = voice(seconds: 16, seed: 2)
        for index in 0..<(8 * Self.rate) { own[index] = 0 }
        let heard = echo(of: far, delay: 14_400)
        let mic = zip(heard, own).map { $0 + $1 }
        let out = run(far: far, mic: mic)

        let range = (10 * Self.rate)..<(15 * Self.rate)
        XCTAssertLessThan(left(in: out, besides: own, from: 10, to: 15), decibels(own[range]) - 10)
        XCTAssertLessThan(left(in: out, besides: own, from: 10, to: 15), decibels(heard[range]))
    }

    func testAMicrophoneWithNothingPlayingIsOnlyDelayed() {
        let own = voice(seconds: 3, seed: 2)
        let out = run(far: [Float](repeating: 0, count: own.count), mic: own)

        for index in stride(from: 0, to: 2 * Self.rate, by: 97) {
            XCTAssertEqual(out[index + EchoCanceller.latency], own[index], accuracy: 1e-4)
        }
    }

    func testAnEchoPairedAheadOfItsSourceIsStillFound() {
        let far = voice(seconds: 12, seed: 1)
        let heard = echo(of: far, delay: -2_400)
        let out = run(far: far, mic: heard)

        let silence = [Float](repeating: 0, count: far.count)
        let range = (8 * Self.rate)..<(11 * Self.rate)
        XCTAssertLessThan(left(in: out, besides: silence, from: 8, to: 11), decibels(heard[range]) - 20)
    }

    func testDevicesOnDifferentClocksAreFollowed() {
        let far = voice(seconds: 24, seed: 1)
        let heard = echo(of: far, delay: 14_400, driftPerMillion: -60)
        let canceller = EchoCanceller()
        let out = run(far: far, mic: heard, canceller: canceller)

        XCTAssertEqual(canceller.skew, 60e-6, accuracy: 15e-6)
        let silence = [Float](repeating: 0, count: far.count)
        let range = (19 * Self.rate)..<(23 * Self.rate)
        XCTAssertLessThan(left(in: out, besides: silence, from: 19, to: 23), decibels(heard[range]) - 15)
    }

    func testSoundThatIsNotAnEchoIsNeverMadeLouder() {
        let far = voice(seconds: 8, seed: 1)
        let own = voice(seconds: 8, seed: 2)
        let out = run(far: far, mic: own)

        let range = (2 * Self.rate)..<(7 * Self.rate)
        XCTAssertLessThan(left(in: out, besides: own, from: 2, to: 7), decibels(own[range]) - 15)
    }

    func testEveryCallReturnsAsManySamplesAsItWasGiven() {
        let canceller = EchoCanceller()
        for count in [1, 7, 480, 1_024, 4_099, 333] {
            let samples = [Float](repeating: 0.1, count: count)
            XCTAssertEqual(canceller.process(reference: samples, mic: Array(samples.prefix(count / 2))).count, count)
        }
        XCTAssertEqual(canceller.process(reference: [], mic: [0.5]).count, 0)
    }

    func testTheSystemTrackWaitsAsLongAsTheMicrophone() {
        var delay = Delay(samples: EchoCanceller.latency)
        let canceller = EchoCanceller()
        let own = voice(seconds: 1, seed: 2)
        var system: [Float] = []
        var mic: [Float] = []
        for start in stride(from: 0, to: own.count, by: 960) {
            let chunk = Array(own[start..<(start + 960)])
            system += delay.push(chunk)
            mic += canceller.process(reference: [Float](repeating: 0, count: 960), mic: chunk)
        }

        XCTAssertEqual(system.count, own.count)
        for index in stride(from: 0, to: own.count - EchoCanceller.latency, by: 53) {
            XCTAssertEqual(system[index + EchoCanceller.latency], own[index])
            XCTAssertEqual(mic[index + EchoCanceller.latency], own[index], accuracy: 1e-4)
        }
    }
}
