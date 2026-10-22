/** Turns a provider's diarized transcript into Eavesy transcript lines. */

export interface BotLine {
  startMs: number;
  endMs: number;
  speakerId: string;
  text: string;
  language: string | null;
}

export interface BotTranscript {
  lines: BotLine[];
  /** `speaker_N` → the participant's display name, for `meetings.speaker_names_json`. */
  speakerNames: Record<string, string>;
  /** The language most lines were heard in, as a base code, or null if none said. */
  language: string | null;
}

/** A long turn is split into lines at a sentence end past this many words, and always by the cap. */
const SOFT_WORDS = 40;
const MAX_WORDS = 90;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function seconds(value: unknown): number | null {
  const relative = record(value).relative;
  return typeof relative === 'number' && Number.isFinite(relative) && relative >= 0 ? relative : null;
}

/**
 * Recall's JSON transcript: one entry per turn, each with the participant and
 * timed words. Participant ids are per meeting, so speakers are numbered in
 * the order they first talk and their display names kept beside.
 */
export function convertRecallTranscript(raw: unknown): BotTranscript {
  const entries = Array.isArray(raw) ? raw.map(record) : [];
  const speakerByParticipant = new Map<string, string>();
  const speakerNames: Record<string, string> = {};
  const languageCounts = new Map<string, number>();
  const lines: BotLine[] = [];

  for (const entry of entries) {
    const participant = record(entry.participant);
    const key = typeof participant.id === 'number' || typeof participant.id === 'string' ? String(participant.id) : 'unknown';
    const speakerId = speakerByParticipant.get(key) ?? `speaker_${speakerByParticipant.size}`;
    speakerByParticipant.set(key, speakerId);
    const name = typeof participant.name === 'string' ? participant.name.trim().slice(0, 80) : '';
    if (name && !speakerNames[speakerId]) speakerNames[speakerId] = name;
    const code = typeof entry.language_code === 'string' && entry.language_code ? entry.language_code.split('-')[0].toLowerCase() : null;

    const words = (Array.isArray(entry.words) ? entry.words.map(record) : [])
      .map((word) => ({
        text: typeof word.text === 'string' ? word.text.trim() : '',
        start: seconds(word.start_timestamp),
        end: seconds(word.end_timestamp),
      }))
      .filter((word) => word.text && word.start !== null);

    let chunk: typeof words = [];
    const flush = () => {
      if (!chunk.length) return;
      const startMs = Math.round(chunk[0].start! * 1_000);
      const last = chunk.at(-1)!;
      const endMs = Math.max(startMs, Math.round((last.end ?? last.start!) * 1_000));
      lines.push({ startMs, endMs, speakerId, text: chunk.map((w) => w.text).join(' '), language: code });
      if (code) languageCounts.set(code, (languageCounts.get(code) ?? 0) + 1);
      chunk = [];
    };
    for (const word of words) {
      chunk.push(word);
      if (chunk.length >= MAX_WORDS || (chunk.length >= SOFT_WORDS && /[.!?]$/.test(word.text))) flush();
    }
    flush();
  }

  lines.sort((a, b) => a.startMs - b.startMs);
  let language: string | null = null;
  let best = 0;
  for (const [code, count] of languageCounts) {
    if (count > best) {
      best = count;
      language = code;
    }
  }
  return { lines, speakerNames, language };
}
