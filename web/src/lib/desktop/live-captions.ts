/** A caption from the Mac's on-device recognizer (`recording:caption`). */
export interface LiveCaption {
  sessionId: string;
  track: string;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
  /**
   * Words only the fast preview recognizer has heard. Shown like any partial;
   * the accurate text replaces them under the same `startMs`.
   */
  preview?: boolean;
}

/** A line of a recording in progress (`live_transcript`): cloud, or provisional on-device text. */
export interface LiveLine {
  startMs: number;
  endMs: number;
  track: string | null;
  text: string;
  provisional: boolean;
}

/** Who a track is, for labelling captions: your mic, or the call's audio. */
export function trackLabel(track: string | null | undefined): string | null {
  if (track === 'mic') return 'You';
  if (track === 'system') return 'Others';
  return null;
}

/** The end of `text`, cut at a word, so a one-line caption shows the latest words. */
export function captionTail(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const tail = clean.slice(clean.length - max);
  const space = tail.indexOf(' ');
  return `…${space > 0 && space < 20 ? tail.slice(space + 1) : tail}`;
}

/**
 * What to show under a live recording: the stored lines (cloud lines replace
 * provisional ones as they arrive), then whatever the recognizer is still
 * hearing that isn't stored yet.
 */
export interface LiveRow {
  text: string;
  provisional: boolean;
  /** "You" or "Others" when the line's track is known. */
  label: string | null;
}

export function liveView(lines: LiveLine[], partials: LiveCaption[], keep = 3): LiveRow[] {
  const recent = lines
    .slice(-keep)
    .map(({ text, provisional, track }) => ({ text, provisional, label: trackLabel(track) }));
  // Keep the last final on screen until its persisted row arrives. Tracks
  // advance independently: computer audio must not hide newer mic words.
  const hearing = partials
    .filter((caption) => {
      const lastEnd = lines.filter((line) => line.track === caption.track).reduce((end, line) => Math.max(end, line.endMs), -1);
      return caption.text.trim() && caption.endMs > lastEnd;
    })
    .sort((a, b) => a.startMs - b.startMs)
    .map((caption) => ({ text: caption.text, provisional: true, label: trackLabel(caption.track) }));
  return [...recent, ...hearing].slice(-keep);
}

/** Everything heard so far in one recording: the settled lines and, per track, what is still being heard. */
export interface RunningTranscript {
  sessionId: string | null;
  finals: LiveCaption[];
  partials: Record<string, LiveCaption>;
}

export const EMPTY_RUNNING: RunningTranscript = { sessionId: null, finals: [], partials: {} };

/** Adds a caption; one from another recording starts over. */
export function addCaption(state: RunningTranscript, caption: LiveCaption): RunningTranscript {
  const base = state.sessionId === caption.sessionId ? state : { ...EMPTY_RUNNING, sessionId: caption.sessionId };
  if (!caption.text.trim()) return base;
  const samePhrase = (previous: LiveCaption) => {
    const overlap = Math.min(previous.endMs, caption.endMs) - Math.max(previous.startMs, caption.startMs);
    const longest = Math.max(previous.endMs - previous.startMs, caption.endMs - caption.startMs);
    if (previous.track !== caption.track) return false;
    if (previous.startMs === caption.startMs) return true;
    const shortest = Math.min(previous.endMs - previous.startMs, caption.endMs - caption.startMs);
    const coverage = previous.isFinal && caption.isFinal ? longest : shortest;
    if (overlap <= 0 || overlap <= coverage / 2) return false;
    const normalize = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
    const left = normalize(previous.text);
    const right = normalize(caption.text);
    if (!left.trim() || !right.trim()) return false;
    if (previous.isFinal && caption.isFinal) return left === right;
    return left.includes(right) || right.includes(left);
  };
  const partials = Object.fromEntries(Object.entries(base.partials).filter(([, previous]) => !samePhrase(previous)));
  if (!caption.isFinal) {
    if (!base.finals.some(samePhrase)) partials[`${caption.track}:${caption.startMs}`] = caption;
    return { ...base, partials };
  }
  return { ...base, finals: [...base.finals.filter((previous) => !samePhrase(previous)), caption], partials };
}

/** The running transcript as plain text: settled words, then the words still being heard. */
export function runningText(state: RunningTranscript): string {
  const byTime = (a: LiveCaption, b: LiveCaption) => a.startMs - b.startMs || a.endMs - b.endMs;
  return [...state.finals, ...Object.values(state.partials)].sort(byTime)
    .map((caption) => caption.text.trim())
    .filter(Boolean)
    .join(' ');
}
