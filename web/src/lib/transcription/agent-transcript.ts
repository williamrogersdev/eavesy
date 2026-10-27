import { hasBothSides, speakerName } from './two-track';

export type TranscriptKind = 'solo' | 'conversation';

export interface AgentLine {
  speakerId: string | null;
  startMs: number;
  endMs: number;
  text: string;
}

export interface Turn {
  speaker: string | null;
  text: string;
}

/** A pause this long in a one-person recording starts a new paragraph. */
export const PARAGRAPH_PAUSE_MS = 3_000;
const PARAGRAPH_MAX_CHARS = 900;

/** Both sides of a call spoke: who said what matters. Otherwise it is one voice. */
export function transcriptKind(lines: { speakerId: string | null }[]): TranscriptKind {
  return hasBothSides(lines) ? 'conversation' : 'solo';
}

/**
 * Consecutive lines from the same speaker become one turn. A one-person
 * recording becomes paragraphs, split at long pauses.
 */
export function toTurns(
  lines: AgentLine[],
  kind: TranscriptKind,
  names: Record<string, string> = {},
): Turn[] {
  const turns: Turn[] = [];
  let lastEnd = 0;
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    const last = turns.at(-1);
    if (kind === 'conversation') {
      const speaker = line.speakerId ? speakerName(line.speakerId, names) : (last?.speaker ?? null);
      if (last && last.speaker === speaker) last.text = `${last.text} ${text}`;
      else turns.push({ speaker, text });
    } else {
      const pause = line.startMs - lastEnd;
      const long = last && last.text.length > PARAGRAPH_MAX_CHARS && /[.!?]$/.test(last.text);
      if (last && pause < PARAGRAPH_PAUSE_MS && !long) last.text = `${last.text} ${text}`;
      else turns.push({ speaker: null, text });
    }
    lastEnd = Math.max(lastEnd, line.endMs);
  }
  return turns;
}

const FILLERS = /(^|[\s,.;:!?])(?:u+m+|u+h+m*|e+r+m+|h+m+|m+h*m+)(?=[\s,.;:!?]|$)[,.]?/gi;
/** "like", "you know" or "I mean" opening the text or a clause, closed by a comma or the sentence's end. Not "like, 5" (about five). */
const DISCOURSE = /(^|[,.;:!?])\s*(?:like(?!,\s*\d)|you know|i mean)(?:,|(?=[.?!]|$))\s*(\S)?/gi;
const STUTTER_WORDS = new Set(['i', 'a', 'the', 'and', 'so', 'we', 'it', 'to', 'you', 'but', 'is', 'in', 'of']);

/**
 * The safe part of cleanup, without a model: drops "um"/"uh"-style fillers,
 * "like"/"you know"/"I mean" where commas set them apart, and stuttered short
 * words, and tidies spacing. Never changes meaning.
 */
export function stripFillers(text: string): string {
  let out = text.replace(FILLERS, '$1');
  // Neighbouring ones share a comma, so one pass can miss the next.
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = out.replace(DISCOURSE, (_match: string, before: string, after: string | undefined) => {
      if (!after) return before;
      // Dropped from the start of a sentence: the next word starts it.
      const next = /[.!?]/.test(before) ? after.toUpperCase() : after;
      return before ? `${before} ${next}` : next;
    });
  }
  out = out.replace(/\b(\w+)(?:[\s,]+\1\b)+/gi, (match: string, word: string) =>
    STUTTER_WORDS.has(word.toLowerCase()) || match.split(/[\s,]+/).length >= 3 ? word : match,
  );
  out = out
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])(?=[,.;:!?])/g, '')
    .replace(/^[\s,.;:]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out ? out[0].toUpperCase() + out.slice(1) : out;
}

export function renderTurns(turns: Turn[]): string {
  return turns.map((turn) => (turn.speaker ? `${turn.speaker}: ${turn.text}` : turn.text)).join('\n\n');
}

function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\s+/g, ' ').trim();
}

export interface EnvelopeMeta {
  title?: string | null;
  startedAt?: number | null;
  project?: string | null;
  speakers?: string[];
}

/**
 * A conversation is context for the agent, not an instruction from the user,
 * so it is wrapped in a tag that says what it is and who is speaking.
 */
export function conversationEnvelope(body: string, meta: EnvelopeMeta): string {
  const attrs: string[] = ['kind="conversation"'];
  if (meta.title?.trim()) attrs.push(`title="${attribute(meta.title)}"`);
  if (meta.startedAt) attrs.push(`date="${new Date(meta.startedAt).toISOString().slice(0, 10)}"`);
  if (meta.project?.trim()) attrs.push(`project="${attribute(meta.project)}"`);
  if (meta.speakers && meta.speakers.length > 0) attrs.push(`speakers="${attribute(meta.speakers.join(', '))}"`);
  // Speech can't close the envelope early: a literal transcript tag in it is escaped.
  const safe = body.trim().replace(/<(\/?transcript)/gi, '&lt;$1');
  return `<transcript ${attrs.join(' ')}>\n${safe}\n</transcript>`;
}

export function speakersOf(turns: Turn[], recorderName?: string): string[] {
  const seen: string[] = [];
  for (const turn of turns) {
    if (turn.speaker && !seen.includes(turn.speaker)) seen.push(turn.speaker);
  }
  return seen.map((speaker) => (speaker === recorderName ? `${speaker} (recorder)` : speaker));
}

/** Groups turns into chunks small enough for one cleanup request each. */
export function chunkTurns(turns: Turn[], maxChars: number): Turn[][] {
  const chunks: Turn[][] = [];
  let current: Turn[] = [];
  let size = 0;
  for (const turn of turns) {
    const length = turn.text.length + (turn.speaker?.length ?? 0) + 4;
    if (current.length > 0 && size + length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(turn);
    size += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
}

/**
 * Cleanup only removes and reformats words, so nearly every word it returns
 * was said. A reply that answers or rewrites the transcript fails this.
 */
function mostlyTheSameWords(input: Turn[], cleaned: string): boolean {
  const said = new Set(input.flatMap((turn) => words(`${turn.speaker ?? ''} ${turn.text}`)));
  const returned = words(cleaned);
  if (returned.length === 0) return false;
  const kept = returned.filter((word) => said.has(word)).length;
  return kept / returned.length >= MIN_WORD_OVERLAP;
}

const MIN_WORD_OVERLAP = 0.8;

/**
 * Whether a model's cleanup of a chunk kept its shape: every conversation turn
 * still there, in order, with its label; a monologue not cut down or padded.
 */
export function cleanedChunkIsValid(input: Turn[], output: string, kind: TranscriptKind): boolean {
  const cleaned = output.trim();
  if (!cleaned) return false;
  const inputChars = input.reduce((sum, turn) => sum + turn.text.length, 0);
  if (cleaned.length < inputChars * 0.3 || cleaned.length > inputChars * 1.4 + 400) return false;
  if (/<\/?transcript/i.test(cleaned)) return false;
  if (!mostlyTheSameWords(input, cleaned)) return false;
  if (kind === 'solo') return true;
  const labels = cleaned
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => input.find((turn) => turn.speaker && block.startsWith(`${turn.speaker}: `))?.speaker ?? null);
  if (labels.includes(null) || labels.length !== input.length) return false;
  return labels.every((label, index) => label === input[index].speaker);
}

