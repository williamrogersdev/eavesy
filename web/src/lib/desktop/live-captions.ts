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
