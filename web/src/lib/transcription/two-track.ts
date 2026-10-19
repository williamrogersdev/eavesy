export type Track = 'mixed' | 'mic' | 'system';
export type SpeakerId = 'you' | 'them';

export const SILENT_TRACK_ACTIVE_MS = 500;

export const ECHO_WINDOW_MS = 3_000;

export function speakerForTrack(track: Track): SpeakerId | null {
  if (track === 'mic') return 'you';
  if (track === 'system') return 'them';
  return null;
}

/**
 * Whether a track's segment is too quiet to be worth transcribing. Only used to
 * skip the idle side of a two-sided call: a mic-only recording (dictation, a
 * voice note) is never skipped, since a quiet mic is still the whole recording
 * and Whisper's own VAD decides what is speech.
 */
export function isSilentTrack(
  track: Track,
  activeMs: number | null,
  opts: { micOnly?: boolean } = {},
): boolean {
  if (opts.micOnly) return false;
  return track !== 'mixed' && activeMs !== null && activeMs < SILENT_TRACK_ACTIVE_MS;
}

const STOCK_PHRASES = [
  'thank you',
  'thank you very much',
  'thanks for watching',
  'thank you for watching',
  'thanks for listening',
  'please subscribe',
  'like and subscribe',
  'subtitles by',
  'transcribed by',
  'bye',
  'you',
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface WhisperLine {
  text: string;
  noSpeechProb?: number;
  compressionRatio?: number;
}

/**
 * Whether a Whisper line is invented rather than heard. `lenient` is for
 * mic-only recordings, where a short note can really be just "thank you" or
 * "bye": a stock phrase is then dropped only when Whisper itself doubted there
 * was speech, not merely because it gave no score.
 */
export function isHallucination(
  line: WhisperLine,
  opts: { lenient?: boolean; glossary?: readonly string[] } = {},
): boolean {
  const text = line.text.trim();
  if (!text) return true;
  if (opts.glossary && readsBackGlossary(line, opts.glossary, opts.lenient ? 3 : 2)) return true;
  if (/^[[(*♪].*[\])*♪]$/.test(text)) return true;
  if (line.noSpeechProb !== undefined && line.noSpeechProb > 0.85) return true;
  if (line.compressionRatio !== undefined && line.compressionRatio > 2.4) return true;
  const normalized = normalize(text);
  const stock = STOCK_PHRASES.some(
    (phrase) => normalized === phrase || (phrase.endsWith(' by') && normalized.startsWith(phrase)),
  );
  if (!stock) return false;
  if (opts.lenient) return line.noSpeechProb !== undefined && line.noSpeechProb > 0.5;
  return line.noSpeechProb === undefined || line.noSpeechProb > 0.3;
}

/**
 * Whisper can read its prompt back on near-silent audio, which for the custom
 * words is a bare list: "Eavesy, Priya Raman, Kubernetes." A line counts as
 * that only when it is nothing but `minTerms` or more of the user's words and
 * Whisper was not sure it heard speech. One word, or a word in a sentence, is
 * always kept.
 */
function readsBackGlossary(line: WhisperLine, glossary: readonly string[], minTerms: number): boolean {
  if (line.noSpeechProb !== undefined && line.noSpeechProb <= 0.3) return false;
  const terms = glossary.map((term) => normalize(term).split(' ').filter(Boolean)).filter((term) => term.length > 0);
  const tokens = normalize(line.text).split(' ').filter(Boolean);
  if (terms.length < minTerms || tokens.length === 0) return false;
  // The most whole glossary terms that tile the line end to end, or -1.
  const most: number[] = new Array<number>(tokens.length + 1).fill(-1);
  most[0] = 0;
  for (let at = 0; at < tokens.length; at += 1) {
    if (most[at] < 0) continue;
    for (const term of terms) {
      if (term.every((word, i) => tokens[at + i] === word)) {
        most[at + term.length] = Math.max(most[at + term.length], most[at] + 1);
      }
    }
  }
  return most[tokens.length] >= minTerms;
}

export interface AttributedLine {
  id: string;
  speakerId: string | null;
  startMs: number;
  endMs: number;
  text: string;
}

function words(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean);
}

function trigrams(tokens: string[]): string[] {
  const grams: string[] = [];
  for (let i = 0; i + 3 <= tokens.length; i += 1) grams.push(tokens.slice(i, i + 3).join(' '));
  return grams;
}

export function findEchoLines(lines: AttributedLine[], windowMs = ECHO_WINDOW_MS): string[] {
  const theirs = lines.filter((line) => line.speakerId === 'them');
  if (theirs.length === 0) return [];
  const echoes: string[] = [];
  for (const mine of lines) {
    if (mine.speakerId !== 'you') continue;
    const nearby = theirs.filter(
      (other) => other.startMs <= mine.endMs + windowMs && other.endMs >= mine.startMs - windowMs,
    );
    if (nearby.length === 0) continue;
    const tokens = words(mine.text);
    if (tokens.length === 0) continue;
    const nearbyText = ` ${nearby.map((other) => words(other.text).join(' ')).join(' | ')} `;
    if (tokens.length < 3) {
      if (nearbyText.includes(` ${tokens.join(' ')} `)) echoes.push(mine.id);
      continue;
    }
    const grams = trigrams(tokens);
    const shared = grams.filter((gram) => nearbyText.includes(` ${gram} `)).length;
    if (shared * 2 >= grams.length) echoes.push(mine.id);
  }
  return echoes;
}

export function hasBothSides(lines: { speakerId: string | null }[]): boolean {
  let you = false;
  let them = false;
  for (const line of lines) {
    if (line.speakerId === 'you') you = true;
    else if (line.speakerId === 'them') them = true;
    if (you && them) return true;
  }
  return false;
}

export const DEFAULT_SPEAKER_NAMES: Record<string, string> = { you: 'You', them: 'Them' };

export function speakerName(id: string, names: Record<string, string> | null | undefined): string {
  const renamed = names?.[id];
  if (renamed) return renamed;
  if (DEFAULT_SPEAKER_NAMES[id]) return DEFAULT_SPEAKER_NAMES[id];
  const numbered = id.match(/^speaker_(\d+)$/);
  return numbered ? `Speaker ${Number(numbered[1]) + 1}` : id;
}

export function parseSpeakerNames(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}
