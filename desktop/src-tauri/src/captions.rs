//! On-device captions from the capture engine: forwarded live to the UI and
//! collected per recording, so dictation can paste without a round trip.

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

/// The settled captions of one recording.
#[derive(Debug, Default)]
pub struct CaptionLog {
    finals: Vec<Caption>,
    unavailable: Option<String>,
}

impl CaptionLog {
    pub fn record(&mut self, caption: &Caption) {
        if caption.is_final && !caption.text.trim().is_empty() {
            self.finals.push(caption.clone());
        }
    }

    pub fn note_status(&mut self, status: &CaptionStatus) {
        if !status.live {
            self.unavailable = status.detail.clone().or_else(|| Some("unavailable".to_string()));
        }
    }

    /// Why captions did not run, if they didn't.
    pub fn unavailable(&self) -> Option<&str> {
        self.unavailable.as_deref()
    }

    /// The finals in spoken order, as one paragraph.
    pub fn text(&self) -> String {
        let mut finals: Vec<&Caption> = self.finals.iter().collect();
        finals.sort_by_key(|c| (c.start_ms, c.end_ms));
        finals
            .iter()
            .map(|c| c.text.trim())
            .collect::<Vec<_>>()
            .join(" ")
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

    #[test]
    fn remembers_why_captions_did_not_run() {
        let mut log = CaptionLog::default();
        log.note_status(&CaptionStatus { session_id: "s".into(), track: "mic".into(), live: true, detail: Some("sfspeech".into()) });
        assert_eq!(log.unavailable(), None);
        log.note_status(&CaptionStatus { session_id: "s".into(), track: "mic".into(), live: false, detail: Some("locale unsupported".into()) });
        assert_eq!(log.unavailable(), Some("locale unsupported"));
    }
}
