import { describe, expect, test } from 'bun:test';
import { ATTACHED_NOTE, attachTranscript, hasAttachedTranscript, splitAttached } from './attached-transcript';

describe('attached transcript', () => {
  const said = 'so can you rename the summarize file to summary and fix the imports, the build keeps failing';
  const prompt = 'Rename the `summarize` file to `summary` and fix the imports.\n\nThe build keeps failing.';

  test('a rewrite carries the whole transcript and says it was rewritten', () => {
    const text = attachTranscript(prompt, said);
    expect(text.startsWith(prompt)).toBe(true);
    expect(text).toContain(said);
    expect(text).toContain(ATTACHED_NOTE);
    expect(hasAttachedTranscript(text)).toBe(true);
  });

  test('splits back into the message and the transcript', () => {
    expect(splitAttached(attachTranscript(prompt, said))).toEqual({ message: prompt, transcript: said });
  });

  test('a message without the block is the words as said', () => {
    expect(splitAttached(prompt)).toEqual({ message: prompt, transcript: null });
    expect(hasAttachedTranscript(prompt)).toBe(false);
  });

  test('a multi-line transcript survives intact', () => {
    const long = 'first line\n\nsecond line with <angle> brackets';
    expect(splitAttached(attachTranscript(prompt, long)).transcript).toBe(long);
  });
});
