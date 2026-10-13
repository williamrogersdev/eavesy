import { describe, expect, mock, test } from 'bun:test';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { mapWhisperResult, transcribeAudioFile } = await import('./transcribe-file');

describe('Workers AI file transcription', () => {
  test('maps the documented turbo response and ignores malformed segments', () => {
    expect(
      mapWhisperResult({
        text: 'Hello world',
        transcription_info: { language: 'en', duration: 1.25 },
        segments: [
          { start: 0.1, end: 0.8, text: ' Hello ' },
          null,
          { start: 'bad', end: Number.NaN, text: 'world' },
        ],
      }),
    ).toEqual({
      text: 'Hello world',
      language: 'en',
      durationSec: 1.25,
      segments: [
        { startMs: 100, endMs: 800, text: 'Hello', isFinal: true },
        { startMs: 0, endMs: 0, text: 'world', isFinal: true },
      ],
    });
  });

  test('falls back to a single timed segment for word-only responses', () => {
    expect(
      mapWhisperResult(
        {
          text: ' Hello world ',
          words: [
            { word: 'Hello', start: 0.2, end: 0.5 },
            { word: 'world', start: 0.6, end: 1.1 },
          ],
        },
        'fr',
      ),
    ).toMatchObject({
      text: ' Hello world ',
      language: 'fr',
      segments: [{ startMs: 200, endMs: 1100, text: 'Hello world', isFinal: true }],
    });
  });

  test('rejects a malformed provider response instead of recording false success', () => {
    expect(() => mapWhisperResult({ error: 'upstream failure' })).toThrow(
      'invalid transcription response',
    );
  });

  test('passes encoded audio to the configured runner', async () => {
    let received: { model: string; input: unknown } | undefined;
    const result = await transcribeAudioFile({
      audio: new Uint8Array([1, 2, 3]),
      language: 'es',
      ai: {
        run(model, input) {
          received = { model, input };
          return Promise.resolve({ text: '' });
        },
      },
    });

    expect(received).toEqual({
      model: '@cf/openai/whisper-large-v3-turbo',
      input: { audio: 'AQID', task: 'transcribe', language: 'es' },
    });
    expect(result.segments).toEqual([]);
  });
});
