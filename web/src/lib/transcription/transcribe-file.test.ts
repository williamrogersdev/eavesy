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
      input: {
        audio: 'AQID',
        task: 'transcribe',
        language: 'es',
        vad_filter: true,
        condition_on_previous_text: false,
      },
    });
    expect(result.segments).toEqual([]);
  });

  test('lets Whisper detect the language when set to auto', async () => {
    let input: Record<string, unknown> = {};
    await transcribeAudioFile({
      audio: new Uint8Array([1]),
      language: 'auto',
      contextBlurb: 'Weekly sync with Priya',
      ai: {
        run(_model, value) {
          input = value as Record<string, unknown>;
          return Promise.resolve({ text: '' });
        },
      },
    });
    expect('language' in input).toBe(false);
    expect(input.initial_prompt).toBe('Weekly sync with Priya');
  });

  test('drops lines Whisper invents on silence and rebuilds the text from what is left', async () => {
    const result = await transcribeAudioFile({
      audio: new Uint8Array([1]),
      ai: {
        run: () =>
          Promise.resolve({
            text: 'Ship it on Friday. Thank you.',
            segments: [
              { start: 0, end: 2, text: ' Ship it on Friday.', no_speech_prob: 0.02 },
              { start: 2, end: 3, text: ' Thank you.', no_speech_prob: 0.6 },
              { start: 3, end: 4, text: ' la la la la la la', compression_ratio: 3.1 },
            ],
          }),
      },
    });
    expect(result.text).toBe('Ship it on Friday.');
    expect(result.segments.map((segment) => segment.text)).toEqual(['Ship it on Friday.']);
  });

  test('a voice note keeps a real short reply and retries without VAD when it hears nothing', async () => {
    const vad: unknown[] = [];
    const result = await transcribeAudioFile({
      audio: new Uint8Array([1]),
      voiceNote: true,
      ai: {
        run(_model, value) {
          const input = value as { vad_filter: boolean };
          vad.push(input.vad_filter);
          return Promise.resolve(
            input.vad_filter
              ? { text: '', segments: [] }
              : { text: 'call mom', segments: [{ start: 0, end: 1, text: 'call mom', no_speech_prob: 0.4 }] },
          );
        },
      },
    });
    expect(vad).toEqual([true, false]);
    expect(result.text).toBe('call mom');

    const thanks = await transcribeAudioFile({
      audio: new Uint8Array([1]),
      voiceNote: true,
      ai: { run: () => Promise.resolve({ text: 'Thank you.', segments: [{ start: 0, end: 1, text: 'Thank you.', no_speech_prob: 0.2 }] }) },
    });
    expect(thanks.text).toBe('Thank you.');
  });
});
