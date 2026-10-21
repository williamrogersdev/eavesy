import { describe, expect, test } from 'bun:test';
import { applyTranscriptEdits, repairTranscript, repairTranscriptSegments } from './repair-transcript';

const edits = (from: string, to: string) => JSON.stringify({ edits: [{ from, to }] });

describe('contextual transcript repair', () => {
  test('repairs recognition errors without rewriting surrounding speech', async () => {
    const raw = 'Ship the fix. Open a pool request for it. That is enough.';
    expect(await repairTranscript(raw, { complete: async () => edits('pool request', 'pull request') }))
      .toEqual({ text: 'Ship the fix. Open a pull request for it. That is enough.', status: 'complete' });
  });
  test('preserves unusual statements when no confident edit exists', async () => {
    const raw = 'The moon is made of cheese. Do not deploy it.';
    expect(await repairTranscript(raw, { complete: async () => '{"edits":[]}' }))
      .toEqual({ text: raw, status: 'complete' });
  });
  test('rejects invented sources, ambiguous matches, number changes and overlapping edits', () => {
    expect(() => applyTranscriptEdits('Hello.', edits('Missing', 'Added'))).toThrow();
    expect(() => applyTranscriptEdits('yes yes', edits('yes', 'no'))).toThrow();
    expect(() => applyTranscriptEdits('Pay $15.', edits('$15', '$50'))).toThrow();
    expect(() => applyTranscriptEdits('Do not deploy.', edits('not deploy', 'deploy'))).toThrow();
    expect(() => applyTranscriptEdits("I can't ship.", edits("can't", 'can'))).toThrow();
    expect(() => applyTranscriptEdits('open pool request', JSON.stringify({ edits: [
      { from: 'open pool', to: 'open pull' }, { from: 'pool request', to: 'pull request' },
    ] }))).toThrow();
  });
  test('invalid or truncated responses preserve the original', async () => {
    for (const response of ['{"edits":[', 'Here is your text.', '{"text":"Summary"}', edits('Hello', '')]) {
      expect(await repairTranscript('Hello', { complete: async () => response }))
        .toEqual({ text: 'Hello', status: 'unavailable' });
    }
  });
  test('provider failures retain raw speech with fallback status', async () => {
    expect(await repairTranscript('A full sentence.', { complete: async () => { throw new Error('timeout'); } }))
      .toEqual({ text: 'A full sentence.', status: 'unavailable' });
  });
  test('blank and large inputs make no model request', async () => {
    const complete = async () => { throw new Error('must not call'); };
    expect(await repairTranscript('', { complete })).toEqual({ text: '', status: 'complete' });
    const raw = 'word '.repeat(3000);
    expect(await repairTranscript(raw, { complete })).toEqual({ text: raw, status: 'unavailable' });
  });
});

describe('Workers AI repair responses', () => {
  test('accepts JSON mode structured responses and supplies confirmed dictionary context', async () => {
    let input: unknown;
    const result = await repairTranscript('Open a pool request.', {
      dictionary: [{ from: 'pool', to: 'pull' }],
      ai: { async run(_model, value) { input = value; return { response: { edits: [{ from: 'pool', to: 'pull' }] }, choices: [{ finish_reason: 'stop' }] }; } },
    });
    expect(result).toEqual({ text: 'Open a pull request.', status: 'complete' });
    expect(JSON.stringify(input)).toContain('human-confirmed');
    expect(JSON.stringify(input)).toContain('pool');
  });
  test('rejects length-truncated generations even when partial JSON parses', async () => {
    expect(await repairTranscript('Hello.', { ai: { async run() { return { response: { edits: [] }, choices: [{ finish_reason: 'length' }] }; } } }))
      .toEqual({ text: 'Hello.', status: 'unavailable' });
  });
});

test('a learned correction cannot be undone by a later model guess', async () => {
  const raw = 'The transcription was kept.';
  const result = await repairTranscript(raw, {
    dictionary: [{ from: 'typed', to: 'kept' }], complete: async () => edits('kept', 'typed'),
  });
  expect(result).toEqual({ text: raw, status: 'complete' });
});


test('rolling-window corrections retain timestamps and raw segment text', async () => {
  const result = await repairTranscriptSegments([
    { startMs: 0, text: 'Open a pool request.' }, { startMs: 2000, text: 'Then ship it.' },
  ], { complete: async () => edits('pool request', 'pull request') });
  expect(result).toEqual([
    { startMs: 0, text: 'Open a pull request.', rawText: 'Open a pool request.' },
    { startMs: 2000, text: 'Then ship it.', rawText: 'Then ship it.' },
  ]);
});

test('an edit crossing timestamp boundaries is not moved into either speaker line', async () => {
  const result = await repairTranscriptSegments([{ text: 'first' }, { text: 'second' }], {
    complete: async () => edits('first\nsecond', 'combined'),
  });
  expect(result.map(s => s.text)).toEqual(['first', 'second']);
});
