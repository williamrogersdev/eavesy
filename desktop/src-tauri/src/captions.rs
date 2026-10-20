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

/// How close to the end of the clip the on-device words must reach for the
/// quick paste: a recognizer running behind has only the start of what was
/// said, sometimes a single "yeah", and pasting that loses the rest.
pub const QUICK_PASTE_SLACK_MS: i64 = 3_000;

/// The captions of one recording, and how they ended.
#[derive(Debug, Default)]
pub struct CaptionLog {
    finals: Vec<Caption>,
    /// Unsettled phrases by track and range; several may be awaiting finals.
    partials: BTreeMap<(String, i64), Caption>,
    unavailable: Option<String>,
    /// Audio a recognizer lost before the recording stopped.
    dropped_live: i64,
    /// How captions ended, merged over every track that reported.
    done: Option<CaptionsDone>,
}

fn same_phrase(a: &Caption, b: &Caption) -> bool {
    let overlap = a.end_ms.min(b.end_ms) - a.start_ms.max(b.start_ms);
    let longest = (a.end_ms - a.start_ms).max(b.end_ms - b.start_ms);
    a.track == b.track && (a.start_ms == b.start_ms || (overlap > 0 && overlap > longest / 2))
}

impl CaptionLog {
    pub fn record(&mut self, caption: &Caption) {
        if caption.text.trim().is_empty() {
            return;
        }
        // A new phrase is not a revision of every earlier phrase on a track.
        // Keep disjoint partials until their own final arrives, including when
        // the previous recognition window is still draining at rollover.
        self.partials.retain(|_, previous| !same_phrase(previous, caption));
        if caption.is_final {
            self.finals.retain(|previous| !same_phrase(previous, caption));
            self.finals.push(caption.clone());
        } else if !self.finals.iter().any(|settled| same_phrase(settled, caption)) {
            self.partials.insert((caption.track.clone(), caption.start_ms), caption.clone());
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

    pub fn note_dropped(&mut self, count: i64) {
        self.dropped_live += count.max(1);
    }

    /// Whether a track has reported how its captions ended.
    pub fn is_done(&self) -> bool {
        self.done.is_some()
    }

    /// What to paste the moment a dictation stops, without waiting for the
    /// recognizer to finish cleanly: every final plus what it was still
    /// hearing, as long as those words reach close to the end of the
    /// `clip_ms`-long clip. A recognizer that could not run, failed, lost
    /// audio, heard nothing or is still behind sends the clip to Whisper.
    /// So does a note that ends in more than `QUICK_PASTE_SLACK_MS` of
    /// silence: it pastes a moment later, whole, rather than risk a gap.
    pub fn quick_paste(&self, clip_ms: i64) -> Paste {
        if self.dropped_live > 0 {
            return Paste::Whisper(format!("{} audio buffers never reached the recognizer", self.dropped_live));
        }
        match self.decide(false) {
            Paste::OnDevice(_) if self.heard_until() < clip_ms - QUICK_PASTE_SLACK_MS => Paste::Whisper(format!(
                "on-device words stop at {:.1}s of a {:.1}s clip",
                self.heard_until() as f64 / 1000.0,
                clip_ms as f64 / 1000.0
            )),
            decision => decision,
        }
    }

    /// Where in the clip the last word the recognizer reported ends.
    fn heard_until(&self) -> i64 {
        self.finals.iter().chain(self.partials.values()).map(|c| c.end_ms).max().unwrap_or(0)
    }

    /// The on-device text, if every bit of the clip reached the recognizer and
    /// it finished; otherwise why Whisper should do it. With no final, the last
    /// partial is the text: it is what the recognizer had heard at the end.
    pub fn paste(&self) -> Paste {
        self.decide(true)
    }

    /// `paste` and `quick_paste` differ only in whether the recognizer must
    /// have reported a clean, timely finish.
    fn decide(&self, need_clean_finish: bool) -> Paste {
        if let Some(reason) = &self.unavailable {
            return Paste::Whisper(format!("captions unavailable: {reason}"));
        }
        match self.done {
            None if need_clean_finish => return Paste::Whisper("captions did not report finishing".to_string()),
            Some(done) if done.failed => return Paste::Whisper("the recognizer failed".to_string()),
            Some(done) if done.timed_out && need_clean_finish => {
                return Paste::Whisper("the recognizer did not finish in time".to_string())
            }
            Some(done) if done.dropped > 0 => {
                return Paste::Whisper(format!("{} audio buffers never reached the recognizer", done.dropped))
            }
            _ => {}
        }
        // Reaching the end is not enough: a recognizer that lost its first
        // window can report a perfectly final tail. Transcribe the full clip
        // rather than presenting that tail as the whole message. A long quiet
        // lead-in takes the same conservative fallback.
        if self.finals.iter().chain(self.partials.values()).map(|c| c.start_ms).min().is_some_and(|start| start > QUICK_PASTE_SLACK_MS) {
            return Paste::Whisper("on-device words are missing the beginning of the clip".to_string());
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

    #[cfg(test)]
    fn sorted_finals(&self) -> Vec<&Caption> {
        let mut finals: Vec<&Caption> = self.finals.iter().collect();
        finals.sort_by_key(|c| (c.start_ms, c.end_ms));
        finals
    }

    fn spoken_captions(&self) -> Vec<&Caption> {
        let mut heard: Vec<_> = self.finals.iter().chain(self.partials.values()).collect();
        heard.sort_by_key(|caption| (caption.start_ms, caption.end_ms));
        heard
    }

    /// Everything heard, as one plain paragraph: the text to paste. The words
    /// the recognizer was still working on at the end count too: the user said
    /// them, and they are usually the last words of the note.
    pub fn spoken_text(&self) -> String {
        self.spoken_captions()
            .into_iter()
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
        let heard = self.spoken_captions();
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

    /// Opt-in integration check for actual CaptionEngines.swift output. The
    /// fixture harness runs without mic capture, playback or foreground input.
    #[test]
    #[ignore = "requires EAVESY_CAPTION_FIXTURE from the signed speech fixture harness"]
    fn real_speech_fixture_preserves_the_whole_message_for_paste() {
        let path = std::env::var("EAVESY_CAPTION_FIXTURE").expect("caption fixture path");
        let input = std::fs::read_to_string(path).expect("read caption events");
        let mut log = CaptionLog::default();
        for line in input.lines().filter(|line| !line.trim().is_empty()) {
            let event: serde_json::Value = serde_json::from_str(line).expect("caption event");
            assert_eq!(event["event"], "caption");
            log.record(&Caption {
                session_id: "fixture".into(), track: "mic".into(),
                text: event["text"].as_str().expect("text").into(),
                is_final: event["final"].as_bool().expect("final"),
                start_ms: event["startMs"].as_i64().expect("start"),
                end_ms: event["endMs"].as_i64().expect("end"),
            });
        }
        log.finish(CLEAN);
        let Paste::OnDevice(text) = log.paste() else { panic!("fixture must produce complete on-device text") };
        let normalized = text.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect::<String>();
        let normalized = normalized.split_whitespace().map(|word| match word { "1st" => "first", "2" => "two", "3" => "three", _ => word }).collect::<Vec<_>>().join(" ");
        for sentence in ["blue notebook", "kitchen table", "three green apples", "meeting tomorrow",
            "first draft", "every sentence in order", "red folder", "last friday", "printed pages",
            "beside the window", "two proposals", "important differences", "new chairs",
            "notebooks for everyone", "short break", "delivery schedule", "first section explains the problem",
            "middle section describes our plan", "last section lists the next steps", "close the windows",
            "turn off the lights", "spare key in the drawer", "call alex before"] {
            assert!(normalized.contains(sentence), "missing phrase {sentence:?} in {text}");
        }
        assert_eq!(log.quick_paste(50_814), Paste::OnDevice(text.clone()));
        if let Ok(path) = std::env::var("EAVESY_CAPTION_PASTE_OUTPUT") {
            std::fs::write(path, text).expect("save assembled paste");
        }
    }

    #[test]
    fn quick_paste_keeps_earlier_phrases_while_finals_are_pending() {
        let mut log = CaptionLog::default();
        log.record(&caption("Start of the message.", false, 0));
        log.record(&caption("Middle of the message.", false, 2_000));
        log.record(&caption("Trailing end.", false, 4_000));
        assert_eq!(log.quick_paste(5_000), Paste::OnDevice("Start of the message. Middle of the message. Trailing end.".into()));
        // Older finals can arrive after the next phrase starts.
        log.record(&caption("Start of the message.", true, 0));
        log.record(&caption("Middle of the message.", true, 2_000));
        assert_eq!(log.spoken_text(), "Start of the message. Middle of the message. Trailing end.");
        log.record(&caption("Trailing end.", true, 4_000));
        assert_eq!(log.spoken_text(), "Start of the message. Middle of the message. Trailing end.");
    }

    #[test]
    fn slight_window_boundary_overlap_keeps_both_phrases() {
        let mut log = CaptionLog::default();
        let mut first = caption("First sentence.", true, 0);
        first.end_ms = 1_000;
        let mut next = caption("Next sentence.", true, 900);
        next.end_ms = 2_000;
        log.record(&first);
        log.record(&next);
        assert_eq!(log.spoken_text(), "First sentence. Next sentence.");
        let mut revision = first.clone();
        revision.start_ms = 10;
        revision.text = "Corrected first sentence.".into();
        log.record(&revision);
        assert_eq!(log.spoken_text(), "Corrected first sentence. Next sentence.");
    }

    #[test]
    fn quiet_lead_in_threshold_is_deliberately_conservative() {
        for start in [QUICK_PASTE_SLACK_MS, QUICK_PASTE_SLACK_MS + 1] {
            let mut log = CaptionLog::default();
            log.record(&caption("Complete words after silence.", true, start));
            log.finish(CLEAN);
            // Without independent audio coverage evidence, silence and a lost
            // first window are indistinguishable. Prefer full-clip recovery.
            assert_eq!(matches!(log.quick_paste(start + 500), Paste::OnDevice(_)), start == QUICK_PASTE_SLACK_MS);
        }
    }

    #[test]
    fn revisions_replace_only_their_phrase_without_duplicating_words() {
        let mut log = CaptionLog::default();
        log.record(&caption("First", false, 0));
        log.record(&caption("First sentence.", false, 0));
        log.record(&caption("Last", false, 2_000));
        log.record(&caption("First sentence.", true, 0));
        log.record(&caption("Last sentence.", true, 2_000));
        log.record(&caption("Last sentence.", true, 2_000));
        assert_eq!(log.spoken_text(), "First sentence. Last sentence.");
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
        assert!(matches!(log.quick_paste(1_000), Paste::Whisper(_)));
    }

    #[test]
    fn the_quick_paste_does_not_wait_for_a_clean_finish() {
        let mut log = CaptionLog::default();
        log.record(&caption("Send it", true, 0));
        log.record(&caption("today", false, 900));
        assert!(!log.is_done());
        assert_eq!(log.quick_paste(2_000), Paste::OnDevice("Send it today".into()));
        log.finish(CaptionsDone { timed_out: true, ..CLEAN });
        assert_eq!(log.quick_paste(2_000), Paste::OnDevice("Send it today".into()));
        assert!(matches!(CaptionLog::default().quick_paste(2_000), Paste::Whisper(_)), "nothing heard");
        let mut failed = CaptionLog::default();
        failed.record(&caption("x", true, 0));
        failed.finish(CaptionsDone { failed: true, ..CLEAN });
        assert!(matches!(failed.quick_paste(2_000), Paste::Whisper(_)));
    }

    #[test]
    fn the_quick_paste_needs_words_within_the_slack_of_the_end() {
        let mut log = CaptionLog::default();
        log.record(&caption("Start.", true, 0));
        log.record(&caption("Done.", true, 9_500)); // ends at 10_000
        assert!(matches!(log.quick_paste(10_000 + QUICK_PASTE_SLACK_MS), Paste::OnDevice(_)));
        assert!(matches!(log.quick_paste(10_001 + QUICK_PASTE_SLACK_MS), Paste::Whisper(_)));
    }

    #[test]
    fn a_final_tail_alone_must_not_pass_for_the_whole_message() {
        let mut log = CaptionLog::default();
        log.record(&caption("Only the trailing end.", true, 35_000));
        log.finish(CLEAN);
        assert!(matches!(log.quick_paste(36_000), Paste::Whisper(_)));
        assert!(matches!(log.paste(), Paste::Whisper(_)));
    }

    #[test]
    fn audio_lost_while_recording_sends_the_quick_paste_to_whisper() {
        let mut log = CaptionLog::default();
        log.record(&caption("the last words", true, 9_500));
        log.note_dropped(3);
        assert!(matches!(log.quick_paste(10_000), Paste::Whisper(_)));
    }

    #[test]
    fn a_recognizer_that_is_behind_never_pastes_just_the_start() {
        // 40 seconds said; the recognizer has only got to the first word.
        let mut log = CaptionLog::default();
        log.record(&caption("Yeah", false, 0));
        assert!(matches!(log.quick_paste(40_000), Paste::Whisper(_)));
        // Words up to near the end: a short pause before stopping is fine.
        log.record(&caption("Yeah, so the plan is this.", true, 0));
        log.record(&caption("and that's it", false, 37_000));
        assert_eq!(log.quick_paste(40_000), Paste::OnDevice("Yeah, so the plan is this. and that's it".into()));
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
