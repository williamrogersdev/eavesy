import { expect, test } from 'bun:test';
import { sentenceSegments } from './sentences';
import { mapWhisperResult } from './transcribe-file';

test('a long segment becomes one line per sentence, timed by its words', () => {
  const text = 'Show the deck. Oh, hold on! This costs $5.19 here.';
  const words = text.split(' ').map((word, i) => ({ word, start: 1 + i * 2, end: 2 + i * 2 }));
  const mapped = mapWhisperResult({ text, segments: [{ text, start: 1, end: 20, words }] });
  expect(sentenceSegments(mapped.segments)).toEqual([
    { startMs: 1000, endMs: 6000, text: 'Show the deck.' },
    { startMs: 7000, endMs: 12000, text: 'Oh, hold on!' },
    { startMs: 13000, endMs: 20000, text: 'This costs $5.19 here.' },
  ]);
});

test('words listed beside the segments are used for the segment they fall in', () => {
  const mapped = mapWhisperResult({
    text: 'One two. Three.',
    segments: [{ text: 'One two. Three.', start: 0, end: 9 }],
    words: [{ word: 'One', start: 0, end: 1 }, { word: 'two.', start: 1, end: 2 }, { word: 'Three.', start: 8, end: 9 }],
  });
  expect(sentenceSegments(mapped.segments)).toEqual([
    { startMs: 0, endMs: 2000, text: 'One two.' },
    { startMs: 8000, endMs: 9000, text: 'Three.' },
  ]);
});

test('without matching words a sentence gets its share of the segment', () => {
  const lines = sentenceSegments([{ startMs: 0, endMs: 10000, text: 'Four. Five.', isFinal: true, words: [{ startMs: 0, endMs: 10 }] }]);
  expect(lines.map((line) => line.text)).toEqual(['Four.', 'Five.']);
  expect(lines[0].startMs).toBe(0);
  expect(lines[0].endMs).toBeLessThanOrEqual(lines[1].startMs);
  expect(lines[1].endMs).toBe(10000);
});

test('one sentence and untimed segments are left whole', () => {
  expect(sentenceSegments([{ startMs: 5, endMs: 9, text: 'Just this', isFinal: true, noSpeechProb: 0.1 }])).toEqual([{ startMs: 5, endMs: 9, text: 'Just this' }]);
  expect(sentenceSegments([{ startMs: 0, endMs: 0, text: 'A. B.', isFinal: true }])).toEqual([{ startMs: 0, endMs: 0, text: 'A. B.' }]);
});
