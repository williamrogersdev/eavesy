//! On-device captions from the capture engine: forwarded live to the UI and
//! collected per recording, so dictation can paste without a round trip.

use std::collections::BTreeMap;

use serde::Serialize;

/// One `caption` line from the capture engine, tagged with its recording.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    pub session_id: String,
    pub track: String,
    pub text: String,
    pub is_final: bool,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// Whether captions are running for a track, and why not when they aren't.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionStatus {
    pub session_id: String,
    pub track: String,
    pub live: bool,
    pub detail: Option<String>,
}

/// How a track's captions ended (`captions_done`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptionsDone {
    pub dropped: i64,
    pub timed_out: bool,
    pub failed: bool,
}

/// What to paste when a dictation stops.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Paste {
    OnDevice(String),
    /// Transcribe the clip with cloud Whisper instead, for this reason.
    Whisper(String),
}

/// The captions of one recording, and how they ended.
#[derive(Debug, Default)]
pub struct CaptionLog {
    finals: Vec<Caption>,
    /// Per track, what the recognizer is hearing past its last final.
    partials: BTreeMap<String, Caption>,
    unavailable: Option<String>,
    /// How captions ended, merged over every track that reported.
    done: Option<CaptionsDone>,
}

impl CaptionLog {
    pub fn record(&mut self, caption: &Caption) {
        if caption.text.trim().is_empty() {
            return;
        }
        if caption.is_final {
            self.finals.push(caption.clone());
            self.partials.remove(&caption.track);
        } else {
            self.partials.insert(caption.track.clone(), caption.clone());
        }
    }

    /// Each track reports its own `captions_done`: a clean finish on one must
    /// not hide a failure or dropped audio on the other.
    pub fn finish(&mut self, done: CaptionsDone) {
        self.done = Some(match self.done {
            None => done,
            Some(seen) => CaptionsDone {
                dropped: seen.dropped + done.dropped,
                timed_out: seen.timed_out || done.timed_out,
                failed: seen.failed || done.failed,
            },
        });
    }

    /// Whether a track has reported how its captions ended.
    pub fn is_done(&self) -> bool {
        self.done.is_some()
    }

    /// What to paste the moment a dictation stops, without waiting for the
    /// recognizer to finish cleanly: every final plus what it was still
    /// hearing. Only a recognizer that could not run, failed, or lost audio
    /// (or heard nothing) sends the clip to Whisper instead.
    pub fn quick_paste(&self) -> Paste {
        if let Some(reason) = &self.unavailable {
            return Paste::Whisper(format!("captions unavailable: {reason}"));
        }
        if let Some(done) = self.done {
            if done.failed {
                return Paste::Whisper("the recognizer failed".to_string());
            }
            if done.dropped > 0 {
                return Paste::Whisper(format!("{} audio buffers never reached the recognizer", done.dropped));
            }
        }
        let text = self.spoken_text();
        if text.is_empty() {
            Paste::Whisper("no words recognized on device".to_string())
        } else {
            Paste::OnDevice(text)
        }
    }

    /// The on-device text, if every bit of the clip reached the recognizer and
    /// it finished; otherwise why Whisper should do it. With no final, the last
    /// partial is the text: it is what the recognizer had heard at the end.
    pub fn paste(&self) -> Paste {
        if let Some(reason) = &self.unavailable {
            return Paste::Whisper(format!("captions unavailable: {reason}"));
        }
        let Some(done) = self.done else {
            return Paste::Whisper("captions did not report finishing".to_string());
        };
        if done.failed {
            return Paste::Whisper("the recognizer failed".to_string());
        }
        if done.timed_out {
            return Paste::Whisper("the recognizer did not finish in time".to_string());
        }
        if done.dropped > 0 {
            return Paste::Whisper(format!("{} audio buffers never reached the recognizer", done.dropped));
        }
        let text = self.spoken_text();
        if text.is_empty() {
            Paste::Whisper("no words recognized on device".to_string())
        } else {
            Paste::OnDevice(text)
        }
    }

    pub fn note_status(&mut self, status: &CaptionStatus) {
        if !status.live {
            self.unavailable = status.detail.clone().or_else(|| Some("unavailable".to_string()));
        }
    }

    fn sorted_finals(&self) -> Vec<&Caption> {
        let mut finals: Vec<&Caption> = self.finals.iter().collect();
        finals.sort_by_key(|c| (c.start_ms, c.end_ms));
        finals
    }

    /// What each track was still hearing past its last final, in spoken order.
    fn trailing_partials(&self) -> Vec<&Caption> {
        let mut partials: Vec<&Caption> = self.partials.values().collect();
        partials.sort_by_key(|c| (c.start_ms, c.end_ms));
        partials
    }

    /// Everything heard, as one plain paragraph: the text to paste. The words
    /// the recognizer was still working on at the end count too: the user said
    /// them, and they are usually the last words of the note.
    pub fn spoken_text(&self) -> String {
        self.sorted_finals()
            .into_iter()
            .chain(self.trailing_partials())
            .map(|c| c.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// The finals in spoken order, as one paragraph.
    #[cfg(test)]
    fn text(&self) -> String {
        self.sorted_finals()
            .iter()
            .map(|c| c.text.trim())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// A provisional transcript to show the moment a recording stops, until the
    /// cloud one replaces it. Unlike `paste`, it takes whatever the recognizer
    /// heard even if it did not finish cleanly: some text now beats none. With
    /// both sides captioned, each turn is labelled the way the cloud labels it.
    pub fn transcript(&self) -> Option<String> {
        let mut heard = self.sorted_finals();
        heard.extend(self.trailing_partials());
        let both_sides = heard.iter().any(|c| c.track == "mic") && heard.iter().any(|c| c.track == "system");
        let mut turns: Vec<(&str, String)> = Vec::new();
        for caption in heard {
            let text = caption.text.trim();
            match turns.last_mut() {
                Some((track, line)) if !both_sides || *track == caption.track => {
                    line.push(' ');
                    line.push_str(text);
                }
                _ => turns.push((caption.track.as_str(), text.to_string())),
            }
        }
        let text = turns
            .into_iter()
            .map(|(track, line)| match (both_sides, track) {
                (true, "mic") => format!("You: {line}"),
                (true, "system") => format!("Them: {line}"),
                _ => line,
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        (!text.is_empty()).then_some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caption(text: &str, is_final: bool, start_ms: i64) -> Caption {
        Caption {
            session_id: "s".into(),
            track: "mic".into(),
            text: text.into(),
            is_final,
            start_ms,
            end_ms: start_ms + 500,
        }
    }

    #[test]
    fn only_finals_make_the_text_in_spoken_order() {
        let mut log = CaptionLog::default();
        log.record(&caption("second part.", true, 30_000));
        log.record(&caption("first par", false, 0));
        log.record(&caption("First part,", true, 0));
        log.record(&caption("   ", true, 40_000));
        assert_eq!(log.text(), "First part, second part.");
    }

    #[test]
    fn no_finals_means_no_text() {
        let mut log = CaptionLog::default();
        log.record(&caption("partial only", false, 0));
        assert_eq!(log.text(), "");
    }

    fn on_track(text: &str, track: &str, start_ms: i64) -> Caption {
        Caption { track: track.into(), ..caption(text, true, start_ms) }
    }

    #[test]
    fn a_one_sided_transcript_is_plain_text() {
        let mut log = CaptionLog::default();
        log.record(&caption("world.", true, 2_000));
        log.record(&caption("Hello", true, 0));
        assert_eq!(log.transcript().as_deref(), Some("Hello world."));
    }

    #[test]
    fn a_two_sided_transcript_labels_each_turn() {
        let mut log = CaptionLog::default();
        log.record(&on_track("Hi there.", "mic", 0));
        log.record(&on_track("How are you?", "mic", 1_000));
        log.record(&on_track("Good, thanks.", "system", 3_000));
        log.record(&on_track("Great.", "mic", 5_000));
        assert_eq!(
            log.transcript().as_deref(),
            Some("You: Hi there. How are you?\n\nThem: Good, thanks.\n\nYou: Great."),
        );
    }

    #[test]
    fn the_paste_text_has_no_speaker_labels() {
        let mut log = CaptionLog::default();
        log.record(&on_track("Hi there.", "mic", 0));
        log.record(&on_track("Good, thanks.", "system", 3_000));
        assert_eq!(log.spoken_text(), "Hi there. Good, thanks.");
    }

    #[test]
    fn the_transcript_does_not_wait_for_a_clean_finish() {
        let mut log = CaptionLog::default();
        log.record(&caption("Kept anyway.", true, 0));
        log.finish(CaptionsDone { dropped: 3, timed_out: true, failed: false });
        assert_eq!(log.transcript().as_deref(), Some("Kept anyway."));
    }

    #[test]
    fn no_words_means_no_transcript() {
        assert_eq!(CaptionLog::default().transcript(), None);
        let mut log = CaptionLog::default();
        log.record(&caption("still talk", false, 0));
        assert_eq!(log.transcript().as_deref(), Some("still talk"));
    }

    const CLEAN: CaptionsDone = CaptionsDone { dropped: 0, timed_out: false, failed: false };

    fn finished(log: &mut CaptionLog, done: CaptionsDone) -> Paste {
        log.finish(done);
        log.paste()
    }

    #[test]
    fn a_clean_finish_pastes_the_on_device_text() {
        let mut log = CaptionLog::default();
        log.record(&caption("Hello there.", true, 0));
        assert_eq!(finished(&mut log, CLEAN), Paste::OnDevice("Hello there.".into()));
    }

    #[test]
    fn with_no_final_the_last_partial_is_pasted() {
        let mut log = CaptionLog::default();
        log.record(&caption("hel", false, 0));
        log.record(&caption("hello wor", false, 0));
        assert_eq!(finished(&mut log, CLEAN), Paste::OnDevice("hello wor".into()));
    }

    #[test]
    fn a_partial_after_the_last_final_is_kept_after_the_finals() {
        let mut log = CaptionLog::default();
        log.record(&caption("First.", true, 0));
        log.record(&caption("and the", false, 2_000));
        log.record(&caption("and the last words", false, 2_000));
        assert_eq!(finished(&mut log, CLEAN), Paste::OnDevice("First. and the last words".into()));
        assert_eq!(log.transcript().as_deref(), Some("First. and the last words"));
    }

    #[test]
    fn a_final_replaces_its_tracks_partial_but_not_the_other_tracks() {
        let mut log = CaptionLog::default();
        log.record(&Caption { track: "system".into(), ..caption("they are still", false, 1_000) });
        log.record(&caption("I said", false, 0));
        log.record(&caption("I said this.", true, 0));
        assert_eq!(log.spoken_text(), "I said this. they are still");
    }

    #[test]
    fn one_tracks_clean_finish_does_not_hide_the_others_failure() {
        let mut log = CaptionLog::default();
        log.record(&caption("Words.", true, 0));
        log.finish(CaptionsDone { dropped: 2, timed_out: false, failed: false });
        log.finish(CLEAN);
        assert!(matches!(log.paste(), Paste::Whisper(_)));
        assert!(matches!(log.quick_paste(), Paste::Whisper(_)));
    }

    #[test]
    fn the_quick_paste_does_not_wait_for_a_clean_finish() {
        let mut log = CaptionLog::default();
        log.record(&caption("Send it", true, 0));
        log.record(&caption("today", false, 900));
        assert!(!log.is_done());
        assert_eq!(log.quick_paste(), Paste::OnDevice("Send it today".into()));
        log.finish(CaptionsDone { timed_out: true, ..CLEAN });
        assert_eq!(log.quick_paste(), Paste::OnDevice("Send it today".into()));
        assert!(matches!(CaptionLog::default().quick_paste(), Paste::Whisper(_)), "nothing heard");
        let mut failed = CaptionLog::default();
        failed.record(&caption("x", true, 0));
        failed.finish(CaptionsDone { failed: true, ..CLEAN });
        assert!(matches!(failed.quick_paste(), Paste::Whisper(_)));
    }

    #[test]
    fn anything_short_of_a_clean_finish_goes_to_whisper() {
        let whisper = |paste: Paste| matches!(paste, Paste::Whisper(_));
        let heard = || {
            let mut log = CaptionLog::default();
            log.record(&caption("Some words.", true, 0));
            log
        };
        assert!(whisper(heard().paste()), "never finished");
        assert!(whisper(finished(&mut heard(), CaptionsDone { timed_out: true, ..CLEAN })));
        assert!(whisper(finished(&mut heard(), CaptionsDone { failed: true, ..CLEAN })));
        assert!(whisper(finished(&mut heard(), CaptionsDone { dropped: 3, ..CLEAN })));
        let mut unavailable = heard();
        unavailable.note_status(&CaptionStatus { session_id: "s".into(), track: "mic".into(), live: false, detail: Some("locale unsupported".into()) });
        assert_eq!(finished(&mut unavailable, CLEAN), Paste::Whisper("captions unavailable: locale unsupported".into()));
        assert!(whisper(finished(&mut CaptionLog::default(), CLEAN)), "silence");
    }

    #[test]
    fn remembers_why_captions_did_not_run() {
        let mut log = CaptionLog::default();
        log.note_status(&CaptionStatus { session_id: "s".into(), track: "mic".into(), live: true, detail: Some("sfspeech".into()) });
        assert_eq!(log.unavailable, None);
        log.note_status(&CaptionStatus { session_id: "s".into(), track: "mic".into(), live: false, detail: Some("locale unsupported".into()) });
        assert_eq!(log.unavailable.as_deref(), Some("locale unsupported"));
    }
}
