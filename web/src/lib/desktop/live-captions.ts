/** A caption from the Mac's on-device recognizer (`recording:caption`). */
export interface LiveCaption {
  sessionId: string;
  track: string;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
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
  const lastEnd = lines.at(-1)?.endMs ?? -1;
  const hearing = partials
    .filter((caption) => !caption.isFinal && caption.text.trim() && caption.endMs > lastEnd)
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
  if (!caption.isFinal) return { ...base, partials: { ...base.partials, [caption.track]: caption } };
  const partials = { ...base.partials };
  delete partials[caption.track];
  return { ...base, finals: [...base.finals, caption], partials };
}

/** The running transcript as plain text: settled words, then the words still being heard. */
export function runningText(state: RunningTranscript): string {
  const byTime = (a: LiveCaption, b: LiveCaption) => a.startMs - b.startMs || a.endMs - b.endMs;
  return [...[...state.finals].sort(byTime), ...Object.values(state.partials).sort(byTime)]
    .map((caption) => caption.text.trim())
    .filter(Boolean)
    .join(' ');
}
