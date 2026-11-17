import Accelerate
import Foundation

/// Takes the far side's sound out of the microphone, so a call played on
/// speakers is not recorded a second time as the user's own voice. The far
/// side is what the system plays: a filter learns how that reaches the
/// microphone and subtracts it, and what little is left is turned down.
/// `process` returns the microphone `latency` samples late.
final class EchoCanceller {
    static let frame = 1_024
    /// The microphone is held back this long, so an echo that was paired a
    /// little ahead of its source can still be matched.
    static let headroom = 4_800
    /// How far into the filter the loudest echo is placed.
    static let lead = 960
    static let latency = headroom + 2 * frame
    static let maxSkew = 3e-4
    static let lookEvery = 6
    static let pathSpan = 15 * 48_000

    private let finder = DelayFinder()
    private let filter = EchoFilter(frame: frame, partitions: 12)
    private let suppressor = ResidualSuppressor(frame: frame)

    /// How far behind its source the far side is read, in samples.
    private(set) var delay = Double(headroom - lead)
    /// Samples the delay grows by per sample, when the microphone and the
    /// speakers run on different clocks.
    private(set) var skew = 0.0
    private var far: [Float] = []
    private var farStart = 0
    private var held = [Float](repeating: 0, count: headroom)
    private var pending: [Float] = []
    private var done = 0
    private var sinceLook = 0
    private var placed = false
    private var doubts = 0
    private var path: [(at: Int, delay: Double)] = []
    private var ready = [Float](repeating: 0, count: frame)

    func process(reference: [Float], mic: [Float]) -> [Float] {
        let count = reference.count
        guard count > 0 else { return [] }
        held.append(contentsOf: mic.prefix(count))
        if mic.count < count { held.append(contentsOf: repeatElement(0, count: count - mic.count)) }
        let delayed = Array(held.prefix(count))
        held.removeFirst(count)

        far.append(contentsOf: reference)
        if let lag = finder.feed(reference: reference, mic: delayed) { anchor(lag) }
        pending.append(contentsOf: delayed)
        while pending.count >= Self.frame {
            let near = Array(pending.prefix(Self.frame))
            pending.removeFirst(Self.frame)
            let played = farBlock()
            let heard = filter.process(far: played, mic: near)
            ready.append(contentsOf: suppressor.process(clean: heard.clean, echo: heard.echo, leak: filter.leak))
            done += Self.frame
            sinceLook += 1
            if sinceLook >= Self.lookEvery {
                sinceLook = 0
                follow()
            }
        }
        let stale = done - DelayFinder.maxLag * DelayFinder.step - 2 * Self.frame - farStart
        if stale > 48_000 {
            far.removeFirst(stale)
            farStart += stale
        }
        let out = Array(ready.prefix(count))
        ready.removeFirst(count)
        return out
    }

    /// Two devices on their own clocks drift apart by a few samples every
    /// second, and the learned echo slides with them. This moves the delay
    /// by what the echo slid and puts the filter back where it was. The rate
    /// is how far the delay has had to move over the last while, so that it
    /// keeps pace by itself.
    private func follow() {
        guard let late = filter.slip() else { return }
        delay += late
        filter.shift(by: late)
        path.append((done, delay))
        while let first = path.first, done - first.at > Self.pathSpan { path.removeFirst() }
        guard let first = path.first, done - first.at >= Self.pathSpan / 5 else { return }
        skew = min(max((delay - first.delay) / Double(done - first.at), -Self.maxSkew), Self.maxSkew)
    }

    /// The far side as it was `delay` samples ago, read between samples when
    /// the delay is not a whole number.
    private func farBlock() -> [Float] {
        var block = [Float](repeating: 0, count: Self.frame)
        let piece = 128
        for at in stride(from: 0, to: Self.frame, by: piece) {
            delay = min(max(delay, Double(Resampler.taps)), Double(DelayFinder.maxLag * DelayFinder.step))
            let position = Double(done + at) - delay
            let whole = Int(position.rounded(.down))
            let part = position - Double(whole)
            if part < 1e-6 {
                block.replaceSubrange(at..<(at + piece), with: farSamples(from: whole, count: piece))
            } else {
                let around = farSamples(from: whole - Resampler.taps / 2 + 1, count: piece + Resampler.taps - 1)
                block.withUnsafeMutableBufferPointer {
                    vDSP_conv(
                        around, 1, Resampler.kernel(part), 1, $0.baseAddress! + at, 1,
                        vDSP_Length(piece), vDSP_Length(Resampler.taps))
                }
            }
            delay += skew * Double(piece)
        }
        return block
    }

    private func farSamples(from start: Int, count: Int) -> [Float] {
        var samples = [Float](repeating: 0, count: count)
        let from = max(start, farStart)
        let to = min(start + count, farStart + far.count)
        if to > from {
            samples.replaceSubrange((from - start)..<(to - start), with: far[(from - farStart)..<(to - farStart)])
        }
        return samples
    }

    /// The filter is moved only when the echo has left the part of it that
    /// leaves room for the room's own reverberation behind the echo, and,
    /// once it has been placed, only after several looks say so.
    private func anchor(_ lag: Int) {
        let within = Double(lag) - delay
        guard within < 240 || within > 4_800 else {
            placed = true
            doubts = 0
            return
        }
        doubts += 1
        guard !placed || doubts >= 4 else { return }
        delay = Double(max(Resampler.taps, lag - Self.lead))
        placed = true
        doubts = 0
        filter.reset()
        path.removeAll()
    }
}

/// Holds a signal back by a fixed number of samples.
struct Delay {
    private var held: [Float]

    init(samples: Int) {
        held = [Float](repeating: 0, count: samples)
    }

    mutating func push(_ samples: [Float]) -> [Float] {
        held.append(contentsOf: samples)
        let out = Array(held.prefix(samples.count))
        held.removeFirst(samples.count)
        return out
    }
}

/// Reads a signal between its samples.
enum Resampler {
    static let taps = 32

    static func kernel(_ part: Double) -> [Float] {
        (0..<taps).map { tap in
            let t = Double(tap - taps / 2 + 1) - part
            guard abs(t) > 1e-9 else { return 1 }
            let window = 0.5 * (1 + cos(Double.pi * t / Double(taps / 2)))
            return Float(sin(Double.pi * t) / (Double.pi * t) * window)
        }
    }
}

/// Finds how late the far side shows up in the microphone, by matching the two
/// at a low sample rate over the last two seconds.
final class DelayFinder {
    static let step = 16
    static let window = 6_000
    static let maxLag = 6_900
    static let every = 1_500
    static let quiet: Float = 1e-7

    private var far: [Float] = []
    private var near: [Float] = []
    private var farSum: Float = 0
    private var nearSum: Float = 0
    private var farLast: Float = 0
    private var nearLast: Float = 0
    private var phase = 0
    private var since = 0
    private var score = [Float](repeating: 0, count: maxLag + 1)
    private var match = [Float](repeating: 0, count: maxLag + 1)
    private var candidate: Int?

    /// A lag in full-rate samples, once two looks in a row agree on it.
    func feed(reference: [Float], mic: [Float]) -> Int? {
        for i in 0..<min(reference.count, mic.count) {
            farSum += reference[i]
            nearSum += mic[i]
            phase += 1
            guard phase == Self.step else { continue }
            let f = farSum / Float(Self.step)
            let n = nearSum / Float(Self.step)
            far.append(f - 0.9 * farLast)
            near.append(n - 0.9 * nearLast)
            farLast = f
            nearLast = n
            farSum = 0
            nearSum = 0
            phase = 0
            since += 1
        }
        let span = Self.window + Self.maxLag
        guard since >= Self.every, far.count >= Self.window + Self.every else { return nil }
        since = 0
        if far.count > 2 * span {
            far.removeFirst(far.count - span)
            near.removeFirst(near.count - span)
        }
        return look()
    }

    private func look() -> Int? {
        let reach = min(Self.maxLag, far.count - Self.window)
        let span = Self.window + reach
        let farTail = Array(far.suffix(span))
        let nearTail = Array(near.suffix(Self.window))
        let nearEnergy = vDSP.sumOfSquares(nearTail)
        guard nearEnergy > Self.quiet * Float(Self.window),
            vDSP.sumOfSquares(farTail) > Self.quiet * Float(span)
        else { return nil }

        vDSP_conv(farTail, 1, nearTail, 1, &match, 1, vDSP_Length(reach + 1), vDSP_Length(Self.window))
        var farEnergy = vDSP.sumOfSquares(farTail[0..<Self.window])
        var best = 0
        var total: Float = 0
        var strength: Float = 0
        for at in 0...reach {
            let lag = reach - at
            let now = abs(match[at]) / (nearEnergy * max(farEnergy, 0) + 1e-20).squareRoot()
            score[lag] = 0.6 * score[lag] + now
            total += score[lag]
            if score[lag] > score[best] {
                best = lag
                strength = now
            }
            if at < reach {
                farEnergy += farTail[at + Self.window] * farTail[at + Self.window] - farTail[at] * farTail[at]
            }
        }
        let mean = total / Float(reach + 1)
        guard strength > 0.08, score[best] > 4 * mean else {
            candidate = nil
            return nil
        }
        defer { candidate = best }
        guard let candidate, abs(candidate - best) <= 15 else { return nil }
        return best * Self.step
    }
}

/// A block of real numbers that vDSP reads and writes in place.
final class Reals {
    let p: UnsafeMutablePointer<Float>
    let count: Int

    init(_ count: Int) {
        self.count = count
        p = .allocate(capacity: count)
        p.initialize(repeating: 0, count: count)
    }

    deinit { p.deallocate() }

    func clear() { vDSP_vclr(p, 1, vDSP_Length(count)) }

    subscript(index: Int) -> Float {
        get { p[index] }
        set { p[index] = newValue }
    }
}

final class Spectrum {
    let re: Reals
    let im: Reals

    init(_ count: Int) {
        re = Reals(count)
        im = Reals(count)
    }

    var split: DSPSplitComplex { DSPSplitComplex(realp: re.p, imagp: im.p) }

    func clear() {
        re.clear()
        im.clear()
    }

    func copy(from other: Spectrum) {
        re.p.update(from: other.re.p, count: re.count)
        im.p.update(from: other.im.p, count: im.count)
    }

    func scale(by gains: Reals) {
        vDSP_vmul(re.p, 1, gains.p, 1, re.p, 1, vDSP_Length(re.count))
        vDSP_vmul(im.p, 1, gains.p, 1, im.p, 1, vDSP_Length(im.count))
    }

    func power(into out: Reals) {
        var view = split
        vDSP_zvmags(&view, 1, out.p, 1, vDSP_Length(re.count))
    }

    var energy: Float {
        var a: Float = 0
        var b: Float = 0
        vDSP_svesq(re.p, 1, &a, vDSP_Length(re.count))
        vDSP_svesq(im.p, 1, &b, vDSP_Length(im.count))
        return a + b
    }
}

/// Forward transforms are scaled by 1/size, so a round trip gives the signal back.
final class Fourier {
    let size: Int
    private let forward: vDSP_DFT_Setup
    private let inverse: vDSP_DFT_Setup
    private let zero: Reals
    private let unused: Reals

    init(size: Int) {
        self.size = size
        forward = vDSP_DFT_zop_CreateSetup(nil, vDSP_Length(size), .FORWARD)!
        inverse = vDSP_DFT_zop_CreateSetup(nil, vDSP_Length(size), .INVERSE)!
        zero = Reals(size)
        unused = Reals(size)
    }

    deinit {
        vDSP_DFT_DestroySetup(forward)
        vDSP_DFT_DestroySetup(inverse)
    }

    func analyze(_ time: UnsafePointer<Float>, into out: Spectrum) {
        vDSP_DFT_Execute(forward, time, zero.p, out.re.p, out.im.p)
        var scale = 1 / Float(size)
        vDSP_vsmul(out.re.p, 1, &scale, out.re.p, 1, vDSP_Length(size))
        vDSP_vsmul(out.im.p, 1, &scale, out.im.p, 1, vDSP_Length(size))
    }

    func synthesize(_ spectrum: Spectrum, into time: UnsafeMutablePointer<Float>) {
        vDSP_DFT_Execute(inverse, spectrum.re.p, spectrum.im.p, time, unused.p)
    }
}

/// The adaptive filter. One copy keeps learning; a second, which only takes
/// over what the first has proven, makes the output, so the user's own voice
/// over the far side cannot wreck what was learned.
final class EchoFilter {
    private let frame: Int
    private let size: Int
    private let partitions: Int
    private let fourier: Fourier
    private let x: Reals
    private var farSpectra: [Spectrum]
    private let learning: [Spectrum]
    private let proven: [Spectrum]
    private let errorSpectrum: Spectrum
    private let echoSpectrum: Spectrum
    private let product: Spectrum
    private let time: Reals
    private let power: Reals
    private let rate: Reals
    private let scaled: Reals
    private let errorPower: Reals
    private let echoPower: Reals
    private let farPower: Reals
    private let errorAverage: Reals
    private let echoAverage: Reals
    private var share: [Float]

    private var adapted = false
    private var sumAdapt: Float = 0
    private var pey: Float = 1
    private var pyy: Float = 1
    private var gapFast: Float = 0
    private var gapSlow: Float = 0
    private var spreadFast: Float = 0
    private var spreadSlow: Float = 0
    private var blocks = 0
    private var strikes = 0
    /// Where speech is strong enough for the filter to keep learning while
    /// the echo slides: about 100 Hz to 3 kHz.
    private static let slipBand = 4...128
    private var promoted = false
    private var shape: [Float]?
    private let turn: Spectrum
    /// How much of the estimated echo is still in the output, 0 to 1.
    private(set) var leak: Float = 0

    init(frame: Int, partitions: Int) {
        self.frame = frame
        self.partitions = partitions
        size = 2 * frame
        fourier = Fourier(size: size)
        x = Reals(size)
        farSpectra = (0...partitions).map { _ in Spectrum(2 * frame) }
        learning = (0..<partitions).map { _ in Spectrum(2 * frame) }
        proven = (0..<partitions).map { _ in Spectrum(2 * frame) }
        errorSpectrum = Spectrum(size)
        echoSpectrum = Spectrum(size)
        product = Spectrum(size)
        turn = Spectrum(size)
        time = Reals(size)
        power = Reals(size)
        rate = Reals(size)
        scaled = Reals(size)
        errorPower = Reals(size)
        echoPower = Reals(size)
        farPower = Reals(size)
        errorAverage = Reals(size)
        echoAverage = Reals(size)
        share = [Float](repeating: 1 / Float(partitions), count: partitions)
    }

    func reset() {
        x.clear()
        (farSpectra + learning + proven).forEach { $0.clear() }
        [power, errorAverage, echoAverage].forEach { $0.clear() }
        share = [Float](repeating: 1 / Float(partitions), count: partitions)
        adapted = false
        sumAdapt = 0
        pey = 1
        pyy = 1
        leak = 0
        strikes = 0
        promoted = false
        shape = nil
        forgetGaps()
    }

    /// How many samples later the learned echo sits than at the last look.
    /// Nothing until the filter has learned something new since then.
    func slip() -> Double? {
        guard adapted, promoted else { return nil }
        promoted = false
        let band = Self.slipBand
        var now = [Float](repeating: 0, count: 2 * partitions * band.count)
        for (p, filter) in proven.enumerated() {
            for (i, k) in band.enumerated() {
                now[2 * (p * band.count + i)] = filter.re[k]
                now[2 * (p * band.count + i) + 1] = filter.im[k]
            }
        }
        guard let before = shape else {
            shape = now
            return nil
        }
        var crossRe = [Double](repeating: 0, count: band.count)
        var crossIm = [Double](repeating: 0, count: band.count)
        for p in 0..<partitions {
            for i in 0..<band.count {
                let at = 2 * (p * band.count + i)
                let a = Double(now[at]), b = Double(now[at + 1])
                let c = Double(before[at]), d = Double(before[at + 1])
                crossRe[i] += a * c + b * d
                crossIm[i] += b * c - a * d
            }
        }
        func match(_ move: Double) -> Double {
            var sum = 0.0
            for (i, k) in band.enumerated() {
                let angle = 2 * Double.pi * Double(k) * move / Double(size)
                sum += crossRe[i] * cos(angle) - crossIm[i] * sin(angle)
            }
            return sum
        }
        let reach = 12.0
        let moves = Array(stride(from: -reach, through: reach, by: 0.25))
        let matches = moves.map(match)
        let at = matches.indices.max { matches[$0] < matches[$1] }!
        guard at > 0, at < moves.count - 1, matches[at] > 0 else {
            shape = now
            return nil
        }
        let curve = matches[at - 1] - 2 * matches[at] + matches[at + 1]
        let late = moves[at] - (curve < 0 ? 0.125 * (matches[at + 1] - matches[at - 1]) / curve : 0)
        if abs(late) < 0.5 { shape = vDSP.add(vDSP.multiply(0.95, before), vDSP.multiply(0.05, now)) }
        return late
    }

    /// Moves what was learned `samples` earlier, for a far side that is from
    /// now on read that much later, so nothing has to be learned again.
    func shift(by samples: Double) {
        for k in 0..<size {
            let angle = 2 * Double.pi * Double(k <= size / 2 ? k : k - size) * samples / Double(size)
            turn.re[k] = Float(cos(angle))
            turn.im[k] = Float(sin(angle))
        }
        var phase = turn.split
        for filter in learning + proven {
            var weights = filter.split
            vDSP_zvmul(&weights, 1, &phase, 1, &weights, 1, vDSP_Length(size), 1)
        }
        for heard in farSpectra {
            var spectrum = heard.split
            vDSP_zvmul(&phase, 1, &spectrum, 1, &spectrum, 1, vDSP_Length(size), -1)
        }
    }

    private func forgetGaps() {
        gapFast = 0
        gapSlow = 0
        spreadFast = 0
        spreadSlow = 0
    }

    func process(far: [Float], mic: [Float]) -> (clean: [Float], echo: [Float]) {
        let full: Float = 32_768
        let silence = [Float](repeating: 0, count: frame)
        x.p.update(from: x.p + frame, count: frame)
        var up = full
        far.withUnsafeBufferPointer { vDSP_vsmul($0.baseAddress!, 1, &up, x.p + frame, 1, vDSP_Length(frame)) }
        let near = vDSP.multiply(full, mic)
        farSpectra.insert(farSpectra.removeLast(), at: 0)
        fourier.analyze(x.p, into: farSpectra[0])
        var farEnergy: Float = 0
        vDSP_svesq(x.p + frame, 1, &farEnergy, vDSP_Length(frame))
        let nearEnergy = vDSP.sumOfSquares(near)

        var provenEcho = estimate(proven)
        var provenError = vDSP.subtract(near, provenEcho)
        var provenLeft = vDSP.sumOfSquares(provenError)
        var learningEcho = estimate(learning)
        var learningError = vDSP.subtract(near, learningEcho)
        var learningLeft = vDSP.sumOfSquares(learningError)
        guard provenLeft.isFinite, learningLeft.isFinite else {
            reset()
            return (mic, silence)
        }

        let apart = vDSP.sumOfSquares(vDSP.subtract(provenEcho, learningEcho))
        let gap = provenLeft - learningLeft
        gapFast = 0.6 * gapFast + 0.4 * gap
        gapSlow = 0.85 * gapSlow + 0.15 * gap
        spreadFast = 0.36 * spreadFast + 0.16 * provenLeft * apart
        spreadSlow = 0.7225 * spreadSlow + 0.0225 * provenLeft * apart
        if gap * abs(gap) > provenLeft * apart || gapFast * abs(gapFast) > 0.5 * spreadFast
            || gapSlow * abs(gapSlow) > 0.25 * spreadSlow
        {
            for p in 0..<partitions { proven[p].copy(from: learning[p]) }
            provenEcho = learningEcho
            provenError = learningError
            provenLeft = learningLeft
            promoted = true
            forgetGaps()
        } else if -gap * abs(gap) > 4 * provenLeft * apart || -gapFast * abs(gapFast) > 4 * spreadFast
            || -gapSlow * abs(gapSlow) > 4 * spreadSlow
        {
            for p in 0..<partitions { learning[p].copy(from: proven[p]) }
            learningEcho = provenEcho
            learningError = provenError
            learningLeft = provenLeft
            forgetGaps()
        }

        if provenLeft > nearEnergy + Float(frame) * 10_000 {
            strikes += 1
            if strikes >= 50 {
                reset()
                return (mic, silence)
            }
        } else {
            strikes = 0
        }
        learn(error: learningError, echo: learningEcho, farEnergy: farEnergy, left: learningLeft)

        guard provenLeft <= nearEnergy else { return (mic, silence) }
        return (vDSP.multiply(1 / full, provenError), vDSP.multiply(1 / full, provenEcho))
    }

    private func estimate(_ filter: [Spectrum]) -> [Float] {
        echoSpectrum.clear()
        var sum = echoSpectrum.split
        var term = product.split
        for p in 0..<partitions {
            var weights = filter[p].split
            var heard = farSpectra[p].split
            vDSP_zvmul(&weights, 1, &heard, 1, &term, 1, vDSP_Length(size), 1)
            vDSP_zvadd(&term, 1, &sum, 1, &sum, 1, vDSP_Length(size))
        }
        fourier.synthesize(echoSpectrum, into: time.p)
        return Array(UnsafeBufferPointer(start: time.p + frame, count: frame))
    }

    private func spectrum(ofLate block: [Float], into out: Spectrum) {
        time.clear()
        block.withUnsafeBufferPointer { (time.p + frame).update(from: $0.baseAddress!, count: frame) }
        fourier.analyze(time.p, into: out)
    }

    private func learn(error: [Float], echo: [Float], farEnergy: Float, left: Float) {
        spectrum(ofLate: error, into: errorSpectrum)
        spectrum(ofLate: echo, into: echoSpectrum)
        errorSpectrum.power(into: errorPower)
        echoSpectrum.power(into: echoPower)
        farSpectra[0].power(into: farPower)

        let left = max(left, Float(frame) * 100)
        let echoEnergy = vDSP.sumOfSquares(echo)
        let together = vDSP.dot(error, echo)
        let smooth = 0.35 / Float(partitions)
        let average = Float(frame) / 48_000
        var nowPey: Float = 1
        var nowPyy: Float = 1
        for k in 0..<size {
            power[k] = (1 - smooth) * power[k] + 1 + smooth * farPower[k]
            let errorMove = errorPower[k] - errorAverage[k]
            let echoMove = echoPower[k] - echoAverage[k]
            nowPey += errorMove * echoMove
            nowPyy += echoMove * echoMove
            errorAverage[k] = (1 - average) * errorAverage[k] + average * errorPower[k]
            echoAverage[k] = (1 - average) * echoAverage[k] + average * echoPower[k]
        }
        nowPyy = nowPyy.squareRoot()
        nowPey /= nowPyy
        let alpha = min(2 * average * echoEnergy, 0.5 * average * left) / left
        pey = (1 - alpha) * pey + alpha * nowPey
        pyy = max((1 - alpha) * pyy + alpha * nowPyy, 1)
        pey = min(max(pey, 0.005 * pyy), pyy)
        leak = pey / pyy

        var residual = (0.0001 * farEnergy + 3 * leak * echoEnergy) / left
        residual = min(max(residual, together * together / (1 + left * echoEnergy)), 0.5)
        if !adapted, sumAdapt > Float(partitions), leak > 0.03 { adapted = true }
        if adapted {
            for k in 0..<size {
                let wanted = min(0.7 * leak * echoPower[k] + 0.3 * residual * (errorPower[k] + 1), 0.5 * errorPower[k])
                rate[k] = wanted / (errorPower[k] + 1) / (power[k] + 10)
            }
        } else {
            let step = farEnergy > Float(frame) * 1_000 ? 0.25 * min(farEnergy, left) / left : 0
            for k in 0..<size { rate[k] = step / (power[k] + 10) }
            sumAdapt += step
        }

        var most: Float = 1
        for p in 0..<partitions {
            share[p] = (1 + learning[p].energy).squareRoot()
            most = max(most, share[p])
        }
        let total = share.reduce(0) { $0 + $1 + 0.1 * most }
        var heard = errorSpectrum.split
        var step = product.split
        for p in 0..<partitions {
            var portion = 0.99 * (share[p] + 0.1 * most) / total
            vDSP_vsmul(rate.p, 1, &portion, scaled.p, 1, vDSP_Length(size))
            var played = farSpectra[p].split
            var weights = learning[p].split
            vDSP_zvmul(&played, 1, &heard, 1, &step, 1, vDSP_Length(size), -1)
            product.scale(by: scaled)
            vDSP_zvadd(&step, 1, &weights, 1, &weights, 1, vDSP_Length(size))
            if p == 0 || (partitions > 1 && blocks % (partitions - 1) == p - 1) {
                fourier.synthesize(learning[p], into: time.p)
                vDSP_vclr(time.p + frame, 1, vDSP_Length(frame))
                fourier.analyze(time.p, into: learning[p])
            }
        }
        blocks += 1
    }
}

/// Turns down what the filter could not subtract: in each band, by as much of
/// the sound as the echo is estimated to still make up.
final class ResidualSuppressor {
    static let floor: Float = 0.1

    private let frame: Int
    private let size: Int
    private let fourier: Fourier
    private let window: [Float]
    private var lastClean: [Float]
    private var lastEcho: [Float]
    private var tail: [Float]
    private let cleanSpectrum: Spectrum
    private let echoSpectrum: Spectrum
    private let cleanPower: Reals
    private let echoPower: Reals
    private let residual: Reals
    private let gain: Reals
    private let time: Reals

    init(frame: Int) {
        self.frame = frame
        size = 2 * frame
        fourier = Fourier(size: size)
        window = (0..<(2 * frame)).map { sin(Float.pi * (Float($0) + 0.5) / Float(2 * frame)) }
        lastClean = [Float](repeating: 0, count: frame)
        lastEcho = [Float](repeating: 0, count: frame)
        tail = [Float](repeating: 0, count: frame)
        cleanSpectrum = Spectrum(size)
        echoSpectrum = Spectrum(size)
        cleanPower = Reals(size)
        echoPower = Reals(size)
        residual = Reals(size)
        gain = Reals(size)
        time = Reals(size)
    }

    func process(clean: [Float], echo: [Float], leak: Float) -> [Float] {
        fourier.analyze(vDSP.multiply(lastClean + clean, window), into: cleanSpectrum)
        fourier.analyze(vDSP.multiply(lastEcho + echo, window), into: echoSpectrum)
        lastClean = clean
        lastEcho = echo
        cleanSpectrum.power(into: cleanPower)
        echoSpectrum.power(into: echoPower)
        let part = leak > 0.5 ? 1 : 2 * leak
        for k in 0..<size {
            residual[k] = max(0.6 * residual[k], part * echoPower[k])
            gain[k] = max(Self.floor, 1 - residual[k] / (cleanPower[k] + 1e-20))
        }
        cleanSpectrum.scale(by: gain)
        fourier.synthesize(cleanSpectrum, into: time.p)
        let shaped = vDSP.multiply(Array(UnsafeBufferPointer(start: time.p, count: size)), window)
        let out = vDSP.add(tail, shaped[0..<frame])
        tail = Array(shaped[frame...])
        return out
    }
}
