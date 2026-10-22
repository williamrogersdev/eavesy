import Foundation

/// A word as a recognizer timed it, in ms on the recording clock. `text`
/// keeps the recognizer's own spacing (" flaky"), so words join as they came.
struct HeardWord: Equatable {
    let text: String
    let startMs: Int64
    let endMs: Int64
}

/// One result from a transcriber, on the recording clock. Volatile results
/// come back as one run over the whole unsettled stretch, so only finals
/// have usable `words`.
struct Heard: Equatable {
    let text: String
    let isFinal: Bool
    let startMs: Int64
    let endMs: Int64
    var words: [HeardWord] = []
}

/// What to send for a track: the arguments of `CaptionSink.recognized`.
struct DraftCaption: Equatable {
    let text: String
    let isFinal: Bool
    let startMs: Int64
    let endMs: Int64
    let preview: Bool
}

/// The words the HUD shows while the accurate transcriber catches up. Two
/// transcribers hear the same audio: the accurate one, whose finals are the
/// only text that is pasted or stored, and a fast one that shows words about
/// a second after they are said but drops and garbles some.
///
/// Everything between two accurate finals is one partial under one start, so
/// each update replaces the last on the host (a partial with the same start
/// is the same phrase). It is the accurate transcriber's volatile text plus
/// whatever the fast one heard past it, and is `preview` while it holds fast
/// words: the host shows those but never pastes or stores them. When an
/// accurate final arrives, its text is sent under that start first, so the
/// final replaces the fast words wherever they were shown.
struct LiveDraft {
    /// Fast-volatile snapshots kept per stretch; one is added a second.
    static let maxSnapshots = 600
    /// Fast settled words kept while no accurate final covers them.
    static let maxFastWords = 400
    /// How far a snapshot's audio may be from where the accurate text ends
    /// and still say how much of the fast volatile text that covers.
    static let snapshotReachMs: Int64 = 1_500

    /// Where the last accurate final ended.
    private var settledMs: Int64?
    /// The accurate transcriber's latest volatile result.
    private var accurate: Heard?
    /// Words the fast transcriber settled that no accurate final covers yet.
    private var fastWords: [HeardWord] = []
    private var fastVolatile: Heard?
    /// How many words the fast volatile had as its audio reached `endMs`,
    /// to find where in its untimed text another transcriber's audio ends.
    private var snapshots: [(endMs: Int64, words: Int)] = []
    /// The start every partial in this stretch is sent under.
    private var key: Int64?
    private var shown: DraftCaption?
    private(set) var previewing = true

    mutating func accurate(_ heard: Heard) -> [DraftCaption] {
        guard heard.isFinal else {
            guard !Self.trim(heard.text).isEmpty, heard.endMs > settledMs ?? .min else { return [] }
            accurate = heard
            return display()
        }
        var out: [DraftCaption] = []
        let text = Self.trim(heard.text)
        // Same start replaces what was shown; the final then replaces this,
        // as it overlaps it with the same words.
        if let key, shown != nil, !text.isEmpty, heard.endMs > max(key, heard.startMs) {
            out.append(DraftCaption(text: text, isFinal: false, startMs: key, endMs: heard.endMs, preview: false))
            self.key = nil
            shown = nil
        }
        out.append(DraftCaption(text: heard.text, isFinal: true, startMs: heard.startMs, endMs: heard.endMs, preview: false))
        let settled = max(settledMs ?? .min, heard.endMs)
        settledMs = settled
        accurate = nil
        fastWords.removeAll { $0.endMs <= settled }
        return out + display()
    }

    /// Never a final: the fast transcriber only previews.
    mutating func fast(_ heard: Heard) -> [DraftCaption] {
        guard previewing else { return [] }
        if heard.isFinal {
            // A word still being said where the accurate text settled is kept,
            // as `fastTail` shows it.
            fastWords += heard.words.filter { $0.endMs > settledMs ?? .min }
            if fastWords.count > Self.maxFastWords { fastWords.removeFirst(fastWords.count - Self.maxFastWords) }
            if let volatile = fastVolatile, volatile.startMs < heard.endMs {
                fastVolatile = nil
                snapshots = []
            }
        } else {
            if fastVolatile?.startMs != heard.startMs { snapshots = [] }
            fastVolatile = heard
            let words = Self.words(heard.text).count
            if let last = snapshots.last, last.endMs == heard.endMs {
                snapshots[snapshots.count - 1].words = words
            } else {
                snapshots.append((heard.endMs, words))
                if snapshots.count > Self.maxSnapshots { snapshots.removeFirst() }
            }
        }
        return display()
    }

    /// Back to the accurate text alone: the recording stopped, or the fast
    /// transcriber failed. Fast words already shown with no accurate text
    /// over them stay until an accurate final replaces them.
    mutating func stopPreview() -> [DraftCaption] {
        guard previewing else { return [] }
        previewing = false
        fastWords = []
        fastVolatile = nil
        snapshots = []
        return display()
    }

    private mutating func display() -> [DraftCaption] {
        let coverMs = max(settledMs ?? .min, accurate?.endMs ?? .min)
        let tail = previewing ? fastTail(after: coverMs) : nil
        let text = [accurate.map { Self.trim($0.text) }, tail?.text]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        guard !text.isEmpty else { return [] }
        let natural = accurate?.startMs ?? tail?.startMs ?? coverMs
        let start = key ?? max(natural, settledMs ?? natural)
        let end = max(accurate?.endMs ?? start, tail?.endMs ?? start, start)
        let caption = DraftCaption(text: text, isFinal: false, startMs: start, endMs: end, preview: tail != nil)
        key = start
        guard caption != shown else { return [] }
        shown = caption
        return [caption]
    }

    /// What the fast transcriber heard past `coverMs`: its settled words by
    /// their times, then its volatile text past the point it had reached
    /// when its audio was nearest `coverMs`. A settled word still being said
    /// at `coverMs` counts: volatile text tends to stop short of its audio.
    private func fastTail(after coverMs: Int64) -> (text: String, startMs: Int64, endMs: Int64)? {
        let settled = fastWords.filter { $0.endMs > coverMs }
        var pieces = [Self.trim(settled.map(\.text).joined())]
        var startMs = settled.first?.startMs
        var endMs = settled.last?.endMs
        if let volatile = fastVolatile, volatile.endMs > coverMs {
            var words = Self.words(volatile.text)
            if volatile.startMs < coverMs {
                // With no snapshot near `coverMs` there is no telling which
                // words the accurate text already has, so none are shown.
                let nearest = snapshots.min { abs($0.endMs - coverMs) < abs($1.endMs - coverMs) }
                if let nearest, abs(nearest.endMs - coverMs) <= Self.snapshotReachMs {
                    words = Array(words.dropFirst(nearest.words))
                } else {
                    words = []
                }
            }
            if !words.isEmpty {
                pieces.append(words.joined(separator: " "))
                startMs = startMs ?? max(volatile.startMs, coverMs)
                endMs = volatile.endMs
            }
        }
        let text = pieces.filter { !$0.isEmpty }.joined(separator: " ")
        guard !text.isEmpty, let startMs, let endMs else { return nil }
        return (text, startMs, endMs)
    }

    private static func trim(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func words(_ text: String) -> [String] {
        text.split(whereSeparator: \.isWhitespace).map(String.init)
    }
}
