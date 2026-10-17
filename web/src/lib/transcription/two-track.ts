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
export function isHallucination(line: WhisperLine, opts: { lenient?: boolean } = {}): boolean {
  const text = line.text.trim();
  if (!text) return true;
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
