import CoreMedia

/// The stretches of a recording the user paused, on the capture clock, and
/// where each captured sample belongs in the file once they are cut out.
/// Samples are placed by their own timestamps, not by when they are
/// delivered, so one that arrives late still lands on the right side of a pause.
struct PauseTimeline {
    private var closed: [(start: CMTime, end: CMTime)] = []
    private var open: CMTime?

    var isPaused: Bool { open != nil }

    /// False when it was already paused.
    mutating func pause(at time: CMTime) -> Bool {
        guard open == nil else { return false }
        // Never before the last resume, so the stretches stay in order.
        open = closed.last.map { CMTimeMaximum($0.end, time) } ?? time
        return true
    }

    /// False when it was not paused.
    mutating func resume(at time: CMTime) -> Bool {
        guard let start = open else { return false }
        open = nil
        if CMTimeCompare(time, start) > 0 { closed.append((start, time)) }
        return true
    }

    /// Where a sample captured at `pts` goes in the file, or nil when any of
    /// it falls inside a pause. A sample that runs into a pause is left out
    /// whole: a short gap is harmless, overlapping audio is not.
    func placed(_ pts: CMTime, duration: CMTime = .zero) -> CMTime? {
        let length = duration.isNumeric && CMTimeCompare(duration, .zero) > 0 ? duration : .zero
        let end = CMTimeAdd(pts, length)
        if let open, CMTimeCompare(end, open) > 0 || CMTimeCompare(pts, open) >= 0 { return nil }
        var cut = CMTime.zero
        for pause in closed {
            if CMTimeCompare(pts, pause.end) >= 0 {
                cut = CMTimeAdd(cut, CMTimeSubtract(pause.end, pause.start))
            } else if CMTimeCompare(end, pause.start) > 0 || CMTimeCompare(pts, pause.start) >= 0 {
                return nil
            }
        }
        return CMTimeSubtract(pts, cut)
    }
}
