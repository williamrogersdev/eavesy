import type { TranscriptSegment } from './types';

export interface TimedWord {
  startMs: number;
  endMs: number;
}

export type WordTimedSegment = TranscriptSegment & { words?: TimedWord[] };

export interface TimedSentence {
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * One timed line per sentence. Whisper's own segments run up to thirty
 * seconds, too long to tell what was said at a given moment of a recording.
 * A sentence takes its times from Whisper's words when they line up with the
 * text, and otherwise from its share of the segment's length.
 */
export function sentenceSegments(segments: readonly WordTimedSegment[]): TimedSentence[] {
  return segments.flatMap((segment) => {
    const whole = { startMs: segment.startMs, endMs: segment.endMs, text: segment.text };
    const sentences = segment.text.match(/\S.*?(?:[.!?…]+["'”’)\]]*(?=\s|$)|$)/gs) ?? [];
    if (sentences.length < 2 || segment.endMs <= segment.startMs) return [whole];
    const counts = sentences.map((sentence) => sentence.trim().split(/\s+/).length);
    const words = segment.words ?? [];
    const total = counts.reduce((sum, count) => sum + count, 0);
    const aligned = words.length === total && words.every((word, i) => word.endMs >= word.startMs && word.startMs >= (words[i - 1]?.startMs ?? 0));
    const length = segment.text.length;
    const span = segment.endMs - segment.startMs;
    let word = 0;
    let offset = 0;
    return sentences.map((sentence, i) => {
      const at = segment.text.indexOf(sentence, offset);
      offset = at + sentence.length;
      const first = word;
      word += counts[i];
      const startMs = aligned ? words[first].startMs : segment.startMs + Math.round((span * at) / length);
      const endMs = aligned ? words[word - 1].endMs : segment.startMs + Math.round((span * offset) / length);
      return { startMs, endMs: Math.max(startMs, endMs), text: sentence.trim() };
    });
  });
}
