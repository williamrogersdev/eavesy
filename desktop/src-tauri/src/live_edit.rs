//! Corrections made while capture is still producing words. The same three-way
//! merge is used by the HUD (live-edit.ts); neither side treats speech as typing.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

#[derive(Clone)]
struct Edit {
    source: String,
    text: String,
    revision: u64,
    updated_at: Instant,
}
static EDITS: LazyLock<Mutex<HashMap<String, Edit>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

const MAX_SESSIONS: usize = 8;
const MAX_EDIT_BYTES: usize = 20 * 1024 * 1024;

pub fn revision(id: &str) -> u64 {
    EDITS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .map_or(0, |edit| edit.revision)
}

pub fn update(id: &str, source: String, text: String, revision: u64) -> Result<(), String> {
    put(
        &mut EDITS.lock().unwrap_or_else(|e| e.into_inner()),
        id,
        source,
        text,
        revision,
    )
}

fn put(
    edits: &mut HashMap<String, Edit>,
    id: &str,
    source: String,
    text: String,
    revision: u64,
) -> Result<(), String> {
    if source.len() > 5 * 1024 * 1024 || text.len() > 5 * 1024 * 1024 {
        return Err("Transcript is too large".into());
    }
    if let Some(previous) = edits.get(id) {
        if revision <= previous.revision {
            if previous.source == source && previous.text == text {
                return Ok(());
            }
            return Err("Live correction is out of date; refocus the editor and retry".into());
        }
    }
    edits.insert(
        id.to_string(),
        Edit {
            source,
            text,
            revision,
            updated_at: Instant::now(),
        },
    );
    // Keep recently finished captures available for their final transcription,
    // without retaining abandoned transcript copies for the process lifetime.
    while edits.len() > MAX_SESSIONS
        || edits
            .values()
            .map(|edit| edit.source.len() + edit.text.len())
            .sum::<usize>()
            > MAX_EDIT_BYTES
    {
        let oldest = edits
            .iter()
            .filter(|(key, _)| key.as_str() != id)
            .min_by_key(|(_, edit)| edit.updated_at)
            .map(|(key, _)| key.clone());
        if let Some(oldest) = oldest {
            edits.remove(&oldest);
        } else {
            break;
        }
    }
    Ok(())
}

pub fn forget(id: &str) {
    EDITS.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
}

pub fn corrected(id: &str, incoming: &str) -> Option<String> {
    let edit = EDITS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned()?;
    Some(merge(&edit.source, &edit.text, incoming))
}

#[derive(Clone)]
struct Patch {
    start: usize,
    end: usize,
    text: String,
}

fn tokens(text: &str) -> Vec<&str> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut previous = None;
    for (index, ch) in text.char_indices() {
        let kind = if ch.is_whitespace() {
            0
        } else if ch.is_alphanumeric() || ch == '_' {
            1
        } else {
            2
        };
        if index > start && (previous != Some(kind) || kind == 2) {
            result.push(&text[start..index]);
            start = index;
        }
        previous = Some(kind);
    }
    if start < text.len() {
        result.push(&text[start..]);
    }
    result
}

fn changes(base: &[&str], next: &[&str]) -> Vec<Patch> {
    let mut prefix = 0;
    while prefix < base.len() && prefix < next.len() && base[prefix] == next[prefix] {
        prefix += 1;
    }
    let (mut end, mut next_end) = (base.len(), next.len());
    let mut suffix = 0;
    while end - suffix > prefix
        && next_end - suffix > prefix
        && base[end - suffix - 1] == next[next_end - suffix - 1]
    {
        suffix += 1;
    }
    if suffix >= 8 || base.len() == next.len() {
        end -= suffix;
        next_end -= suffix;
    }
    let (n, m) = (end - prefix, next_end - prefix);
    if n == 0 && m == 0 {
        return vec![];
    }
    if n == 0 || m == 0 || n.saturating_mul(m) > 1_000_000 {
        return vec![Patch {
            start: prefix,
            end,
            text: next[prefix..next_end].concat(),
        }];
    }
    let width = m + 1;
    let mut distance = vec![0u32; (n + 1) * width];
    for i in 0..=n {
        distance[i * width + m] = (n - i) as u32;
    }
    for j in 0..=m {
        distance[n * width + j] = (m - j) as u32;
    }
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            distance[i * width + j] = if base[prefix + i] == next[prefix + j] {
                distance[(i + 1) * width + j + 1]
            } else {
                1 + distance[(i + 1) * width + j + 1]
                    .min(distance[(i + 1) * width + j])
                    .min(distance[i * width + j + 1])
            };
        }
    }
    let mut result = Vec::new();
    let (mut i, mut j) = (0, 0);
    let mut patch: Option<Patch> = None;
    while i < n || j < m {
        if i < n && j < m && base[prefix + i] == next[prefix + j] {
            if let Some(patch) = patch.take() {
                result.push(patch);
            }
            i += 1;
            j += 1;
        } else {
            let patch = patch.get_or_insert_with(|| Patch {
                start: prefix + i,
                end: prefix + i,
                text: String::new(),
            });
            if i < n
                && j < m
                && distance[(i + 1) * width + j + 1]
                    <= distance[(i + 1) * width + j].min(distance[i * width + j + 1])
            {
                patch.text.push_str(next[prefix + j]);
                j += 1;
                i += 1;
                patch.end = prefix + i;
            } else if j < m
                && (i == n || distance[i * width + j + 1] < distance[(i + 1) * width + j])
            {
                patch.text.push_str(next[prefix + j]);
                j += 1;
            } else {
                i += 1;
                patch.end = prefix + i;
            }
        }
    }
    if let Some(patch) = patch {
        result.push(patch);
    }
    result
}
fn overlaps(a: &Patch, b: &Patch) -> bool {
    if a.start == a.end {
        return a.start > b.start && a.start < b.end;
    }
    if b.start == b.end {
        return b.start > a.start && b.start < a.end;
    }
    a.start < b.end && b.start < a.end
}
pub fn merge(source: &str, text: &str, incoming: &str) -> String {
    if incoming == source || incoming == text {
        return text.to_string();
    }
    if text == source {
        return incoming.to_string();
    }
    let base = tokens(source);
    let mut user = changes(&base, &tokens(text));
    let speech = changes(&base, &tokens(incoming))
        .into_iter()
        .filter_map(|mut patch| {
            if user.iter().any(|own| overlaps(&patch, own)) {
                return None;
            }
            if let Some(own) = user.iter().find(|own| {
                own.start == own.end && patch.start == patch.end && own.start == patch.start
            }) {
                if own.text.starts_with(&patch.text) {
                    return None;
                }
                if patch.text.starts_with(&own.text) {
                    patch.text = patch.text[own.text.len()..].to_string();
                }
            }
            Some(patch)
        })
        .collect::<Vec<_>>();
    user.extend(speech);
    user.sort_by_key(|patch| (patch.start, patch.end));
    let (mut cursor, mut result) = (0, String::new());
    for patch in user {
        result.push_str(&base[cursor..patch.start].concat());
        result.push_str(&patch.text);
        cursor = patch.end;
    }
    result.push_str(&base[cursor..].concat());
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn same_merge_cases_as_the_editor() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../web/src/lib/desktop/live-edit-cases.json"
        ))
        .unwrap();
        for case in cases {
            assert_eq!(
                super::merge(
                    case["source"].as_str().unwrap(),
                    case["text"].as_str().unwrap(),
                    case["incoming"].as_str().unwrap()
                ),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
    #[test]
    fn abandoned_edits_have_bounded_count_and_bytes() {
        let mut edits = std::collections::HashMap::new();
        for n in 0..20 {
            super::put(
                &mut edits,
                &n.to_string(),
                "source".into(),
                "text".into(),
                1,
            )
            .unwrap();
            assert!(edits.len() <= super::MAX_SESSIONS);
        }
        assert!(edits.contains_key("19"));
        for n in 20..24 {
            super::put(
                &mut edits,
                &n.to_string(),
                "s".repeat(5 * 1024 * 1024),
                "t".repeat(5 * 1024 * 1024),
                1,
            )
            .unwrap();
            assert!(
                edits
                    .values()
                    .map(|edit| edit.source.len() + edit.text.len())
                    .sum::<usize>()
                    <= super::MAX_EDIT_BYTES
            );
        }
        assert!(edits.contains_key("23"));
    }

    #[test]
    fn delayed_updates_cannot_replace_a_newer_correction() {
        let id = "revision-test";
        super::update(id, "Hello".into(), "Hi".into(), 2).unwrap();
        assert!(super::update(id, "Hello".into(), "Wrong".into(), 1).is_err());
        assert_eq!(
            super::corrected(id, "Hello again").as_deref(),
            Some("Hi again")
        );
        assert!(super::corrected("another-session", "Hello").is_none());
        super::forget(id);
    }
}
