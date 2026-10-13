import { describe, expect, test } from 'bun:test';
import { WorkersAiSegmentTranscriber } from './workers-ai';

describe('WorkersAiSegmentTranscriber', () => {
  test('maps relative Whisper timestamps and forwards meeting context', async () => {
    let input: unknown;
    const transcriber = new WorkersAiSegmentTranscriber({
      async run(_model, value) {
        input = value;
        return {
          text: 'Hello world',
          transcription_info: { language: 'en', duration: 2.5 },
          segments: [{ start: 0.25, end: 1.75, text: ' Hello world ' }],
        };
      },
    });

    const result = await transcriber.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      language: 'en',
      contextBlurb: 'Alice and Bob discuss launch readiness.',
    });

    expect(input).toMatchObject({
      language: 'en',
      initial_prompt: 'Alice and Bob discuss launch readiness.',
      vad_filter: true,
    });
    expect(result.segments).toEqual([
      { startMs: 250, endMs: 1750, text: 'Hello world', isFinal: true },
    ]);
  });

  test('falls back to one segment when Whisper only returns full text', async () => {
    const transcriber = new WorkersAiSegmentTranscriber({
      async run() {
        return { text: 'Fallback', transcription_info: { duration: 3 } };
      },
    });
    const result = await transcriber.transcribe({ audio: new Uint8Array([1]) });
    expect(result.segments[0]).toMatchObject({ startMs: 0, endMs: 3000, text: 'Fallback' });
  });
});
