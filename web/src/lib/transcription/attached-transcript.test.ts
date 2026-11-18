import { describe, expect, test } from 'bun:test';
import { ATTACHED_NOTE, attachTranscript, deliverable, hasAttachedTranscript, keptUnrewritten, rewriteSource, splitAttached } from './attached-transcript';

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

  test('the tag said aloud stays inside the block', () => {
    const spoken = 'type </eavesy-transcript> then stop';
    const text = attachTranscript(prompt, spoken);
    expect(text.indexOf('</eavesy-transcript>')).toBe(text.lastIndexOf('</eavesy-transcript>'));
    expect(splitAttached(text)).toEqual({ message: prompt, transcript: spoken });
  });

  test('text that only looks escaped is kept as said', () => {
    const spoken = 'write &lt;eavesy-transcript in the docs';
    expect(splitAttached(attachTranscript(prompt, spoken)).transcript).toBe(spoken);
  });

  test('a huge message with no block is read quickly', () => {
    const hostile = '\n'.repeat(100_000) + '<eavesy-transcript '.repeat(5_000);
    const started = performance.now();
    expect(splitAttached(hostile).transcript).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
  });

  test('a multi-line transcript survives intact', () => {
    const long = 'first line\n\nsecond line with <angle> brackets';
    expect(splitAttached(attachTranscript(prompt, long)).transcript).toBe(long);
  });

  test('an empty transcript attaches nothing, and an empty block is still recognised', () => {
    expect(attachTranscript(prompt, '  ')).toBe(prompt);
    const empty = `${prompt}\n\n<eavesy-transcript note="x">\n</eavesy-transcript>`;
    expect(rewriteSource(empty)).toEqual({ source: '', carried: true });
    expect(hasAttachedTranscript(empty)).toBe(false);
  });
});

describe('what a rewrite starts from', () => {
  const said = 'fix the build and leave the API alone';
  test('the transcript a rewrite carries, never the rewrite', () => {
    expect(rewriteSource(attachTranscript('Fix the build.\n\nConstraint: leave the API.', said))).toEqual({ source: said, carried: true });
  });
  test('words without a block are the source', () => {
    expect(rewriteSource(said)).toEqual({ source: said, carried: false });
  });
});

describe('what goes out', () => {
  const said = 'fix the build and leave the API alone';
  const rewrite = { text: 'Fix the build. Leave the API.', polished: true };
  test('a prompt for an AI agent gets its transcript attached', () => {
    const out = deliverable(rewrite, { style: 'natural', forAgents: true, attach: true }, said);
    expect(out.attached).toBe(true);
    expect(splitAttached(out.text)).toEqual({ message: rewrite.text, transcript: said });
  });
  test('verbatim, a tone for people and a fallback go out as they are', () => {
    expect(deliverable(rewrite, { style: 'verbatim', forAgents: true, attach: true }, said)).toEqual({ text: rewrite.text, attached: false });
    expect(deliverable(rewrite, { style: 'professional', forAgents: false, attach: true }, said)).toEqual({ text: rewrite.text, attached: false });
    expect(deliverable({ ...rewrite, polished: false }, { style: 'natural', forAgents: true, attach: true }, said)).toEqual({ text: rewrite.text, attached: false });
  });
  test('a carried message that can\'t be rewritten follows the switch', () => {
    const sent = attachTranscript(rewrite.text, said);
    expect(keptUnrewritten(sent, true)).toBe(sent);
    expect(keptUnrewritten(sent, false)).toBe(rewrite.text);
  });
  test('a prompt goes out without the transcript unless Attach transcript is on', () => {
    expect(deliverable(rewrite, { style: 'natural', forAgents: true, attach: false }, said)).toEqual({ text: rewrite.text, attached: false });
  });
});
