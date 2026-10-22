//! Cuts the call's PCM into segments the way the Mac app does
//! (docs/ARCHITECTURE.md): aim for a minute, close at the first quiet moment
//! after that, never later than half as long again. Segments sit on the
//! meeting's wall clock, so time the audio dropped out is kept as silence and
//! the speaker timeline lines up.

pub const SAMPLE_RATE: u32 = 16_000;
const TARGET_MS: u64 = 60_000;
const MAX_MS: u64 = TARGET_MS * 3 / 2;
/// A block quieter than this is a place to cut.
const QUIET_PEAK: f64 = 0.01;
/// A block louder than this counts toward the segment's speech time.
const ACTIVE_PEAK: f64 = 0.02;
/// Shorter final remainders are dropped: Whisper only hallucinates on them.
const MIN_TAIL_MS: u64 = 1_000;
/// Gaps shorter than this are jitter, not lost audio, and aren't padded.
const PAD_AFTER_SAMPLES: u64 = SAMPLE_RATE as u64 / 2;
const PAD_BLOCK: usize = 4_096;

const fn samples(ms: u64) -> usize {
    (ms * SAMPLE_RATE as u64 / 1_000) as usize
}
const fn millis(samples: u64) -> u64 {
    samples * 1_000 / SAMPLE_RATE as u64
}

pub struct Segment {
    pub idx: u32,
    pub offset_ms: u64,
    pub duration_ms: u64,
    pub active_ms: u64,
    pub wav: Vec<u8>,
}

pub struct Segmenter {
    idx: u32,
    /// Samples already handed out in earlier segments.
    emitted: u64,
    buf: Vec<i16>,
    active: u64,
}

impl Default for Segmenter {
    fn default() -> Self {
        Self { idx: 0, emitted: 0, buf: Vec::with_capacity(samples(MAX_MS) + PAD_BLOCK), active: 0 }
    }
}

impl Segmenter {
    /// Adds a block that ended `elapsed_ms` after recording started. Time
    /// missing before it becomes silence. Returns the segments it completed.
    pub fn push(&mut self, pcm: &[i16], peak: f64, elapsed_ms: u64) -> Vec<Segment> {
        let mut done = Vec::new();
        let starts_at = (elapsed_ms * SAMPLE_RATE as u64 / 1_000).saturating_sub(pcm.len() as u64);
        let total = self.emitted + self.buf.len() as u64;
        if starts_at > total + PAD_AFTER_SAMPLES {
            let silence = [0i16; PAD_BLOCK];
            let mut gap = starts_at - total;
            while gap > 0 {
                let n = gap.min(PAD_BLOCK as u64) as usize;
                self.block(&silence[..n], 0.0, &mut done);
                gap -= n as u64;
            }
        }
        self.block(pcm, peak, &mut done);
        done
    }

    fn block(&mut self, pcm: &[i16], peak: f64, done: &mut Vec<Segment>) {
        self.buf.extend_from_slice(pcm);
        if peak >= ACTIVE_PEAK {
            self.active += pcm.len() as u64;
        }
        let len = self.buf.len();
        if (len >= samples(TARGET_MS) && peak < QUIET_PEAK) || len >= samples(MAX_MS) {
            done.push(self.cut());
        }
    }

    /// The last partial segment, if it's long enough to be worth transcribing.
    pub fn finish(&mut self) -> Option<Segment> {
        (millis(self.buf.len() as u64) >= MIN_TAIL_MS).then(|| self.cut())
    }

    fn cut(&mut self) -> Segment {
        let n = self.buf.len() as u64;
        let segment = Segment {
            idx: self.idx,
            offset_ms: millis(self.emitted),
            duration_ms: millis(n),
            active_ms: millis(self.active.min(n)),
            wav: wav(&self.buf),
        };
        self.idx += 1;
        self.emitted += n;
        self.buf.clear();
        self.active = 0;
        segment
    }
}

/// 16 kHz mono 16-bit PCM WAV: what Whisper resamples everything to anyway,
/// so nothing is lost and no encoder runs in the container. ~1.9 MB a minute.
pub fn wav(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK: usize = 4096;

    /// Feeds blocks back to back; `loud(i)` says whether block i is speech.
    fn feed(seg: &mut Segmenter, blocks: usize, loud: impl Fn(usize) -> bool) -> Vec<Segment> {
        let mut out = Vec::new();
        for i in 0..blocks {
            let level = if loud(i) { 3000i16 } else { 10 };
            let ended = millis(((i + 1) * BLOCK) as u64);
            out.extend(seg.push(&[level; BLOCK], if loud(i) { 0.1 } else { 0.0003 }, ended));
        }
        out
    }

    #[test]
    fn closes_at_the_first_quiet_block_after_a_minute() {
        let mut seg = Segmenter::default();
        // Speech throughout, with a pause at block 250 (64 s in).
        let out = feed(&mut seg, 300, |i| i != 250);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].duration_ms, millis(251 * BLOCK as u64));
        assert_eq!(out[0].offset_ms, 0);
        assert_eq!(out[0].wav.len(), 44 + 251 * BLOCK * 2);
        assert_eq!(out[0].active_ms, millis(250 * BLOCK as u64));
        let tail = seg.finish().unwrap();
        assert_eq!((tail.idx, tail.offset_ms), (1, out[0].duration_ms));
    }

    #[test]
    fn never_runs_past_half_as_long_again() {
        let mut seg = Segmenter::default();
        let out = feed(&mut seg, 400, |_| true);
        assert_eq!(out.len(), 1);
        assert!(out[0].duration_ms >= MAX_MS && out[0].duration_ms < MAX_MS + 300);
    }

    #[test]
    fn silence_closes_right_at_the_minute() {
        let mut seg = Segmenter::default();
        let out = feed(&mut seg, 240, |_| false);
        assert_eq!(out.len(), 1);
        assert!(out[0].duration_ms >= TARGET_MS && out[0].duration_ms < TARGET_MS + 300);
        assert_eq!(out[0].active_ms, 0);
    }

    #[test]
    fn pads_lost_time_with_silence_on_the_wall_clock() {
        let mut seg = Segmenter::default();
        let block = vec![3000i16; BLOCK];
        assert!(seg.push(&block, 0.1, 256).is_empty());
        // The tracks dropped for 90 s; the next block lands on the wall clock
        // and the minute closes inside the silent gap.
        let out = seg.push(&block, 0.1, 90_256 + 256);
        assert_eq!(out.len(), 1);
        assert!(out[0].duration_ms >= TARGET_MS && out[0].duration_ms < TARGET_MS + 300);
        let tail = seg.finish().unwrap();
        assert_eq!(tail.offset_ms + tail.duration_ms, 90_512);
    }

    #[test]
    fn drops_a_tiny_tail() {
        let mut seg = Segmenter::default();
        seg.push(&[0i16; 800], 0.0, 50);
        assert!(seg.finish().is_none());
    }

    #[test]
    fn writes_a_valid_wav_header() {
        let w = wav(&[1, -1]);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(w[4..8].try_into().unwrap()), 36 + 4);
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), 16_000);
        assert_eq!(&w[36..40], b"data");
        assert_eq!(&w[44..], &[1, 0, 0xff, 0xff]);
    }
}
