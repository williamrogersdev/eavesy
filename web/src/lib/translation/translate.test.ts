import { describe, expect, mock, test } from 'bun:test';
import { translateText, translationInput } from './translate';
mock.module('cloudflare:workers', () => ({ env: {}, waitUntil: () => undefined }));
const { translationRequest } = await import('@/server/translation');
import { encodeWav } from '@/lib/imports/wav';
import type { WorkersAiRunner } from '@/lib/ai/embed';

describe('quick translation', () => {
  test('validates languages and bounded nonempty text', () => {
    for (const value of [{ text: '', source: 'auto', target: 'en' }, { text: 'hi', source: 'auto', target: 'xx' }, { text: 'hi', source: 'xx', target: 'en' }, { text: 'x'.repeat(4001), source: 'auto', target: 'en' }]) expect(() => translationInput(value)).toThrow();
  });
  test('preserves original, uses explicit languages, treats requests as text', async () => {
    let submitted: unknown;
    const ai = { run: async (_model: string, input: unknown) => { submitted = input; return { response: '{"translation":"No pagues 250 euros."}' }; } } as WorkersAiRunner;
    const result = await translateText(ai, { text: 'Do not pay 250 euros.', source: 'en', target: 'es' });
    expect(result).toEqual({ text: 'Do not pay 250 euros.', translation: 'No pagues 250 euros.', target: 'es' });
    expect(JSON.stringify(submitted)).toContain('untrusted text');
    expect(JSON.stringify(submitted)).toContain('Spanish');
  });
  test('same language avoids paid generation', async () => {
    const ai = { run: async () => { throw new Error('should not call'); } } as WorkersAiRunner;
    expect((await translateText(ai, { text: 'Hello', source: 'en', target: 'en' })).translation).toBe('Hello');
  });
  test('rejects truncated and malformed model responses', async () => {
    for (const response of [{ response: '{"translation":"cut' }, { response: '{}' }, { response: '{"translation":"Hello"}', choices: [{ finish_reason: 'length' }] }]) {
      const ai = { run: async () => response } as WorkersAiRunner;
      await expect(translateText(ai, { text: 'Hola', source: 'auto', target: 'en' })).rejects.toThrow();
    }
  });
  test('auto-detected speech stays in its language before translation', async () => {
    const calls: { model: string; input: unknown }[] = [];
    const ai = { run: async (model: string, input: unknown) => {
      calls.push({ model, input });
      return model.includes('whisper') ? { text: 'Hola' } : { response: '{"translation":"Hello"}' };
    } } as WorkersAiRunner;
    const audio = Buffer.from(encodeWav(new Float32Array(16000))).toString('base64');
    const response = await translationRequest(new Request('https://test/api/translation', { method: 'POST', body: JSON.stringify({ audio, source: 'auto', target: 'en' }) }), ai);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'Hola', translation: 'Hello', target: 'en' });
    expect(calls[0].input).not.toHaveProperty('language');
    expect(calls[0].input).toHaveProperty('task', 'transcribe');
  });
  test('rejects oversized bodies, invalid audio, and preserves text on provider failure', async () => {
    const ai = { run: async () => { throw new Error('private provider data'); } } as WorkersAiRunner;
    for (const [body, status] of [ ['x'.repeat(2_600_001), 413], ['bad json', 400], [JSON.stringify({ audio: 'bad', source: 'auto', target: 'en' }), 400], [JSON.stringify({ text: 'Hola', source: 'auto', target: 'en' }), 502] ] as const) {
      const response = await translationRequest(new Request('https://test', { method: 'POST', body }), ai);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain('private provider data');
    }
  });
});

test('keeps recognized speech when translation fails, without leaking the provider error', async () => {
  const ai = { run: async (model: string) => {
    if (model.includes('whisper')) return { text: 'Hola, ¿cómo estás?' };
    throw new Error('private provider detail');
  } } as WorkersAiRunner;
  const audio = Buffer.from(encodeWav(new Float32Array(16000))).toString('base64');
  const response = await translationRequest(new Request('https://test', { method: 'POST', body: JSON.stringify({ audio, source: 'es', target: 'en' }) }), ai);
  expect(response.status).toBe(502);
  const body = await response.json() as { text: string; error: string };
  expect(body.text).toBe('Hola, ¿cómo estás?');
  expect(body.error).not.toContain('private provider detail');
});

test('refuses audio beyond one minute before model calls', async () => {
  let calls = 0;
  const ai = { run: async () => { calls++; return {}; } } as WorkersAiRunner;
  const audio = Buffer.from(encodeWav(new Float32Array(16000 * 61))).toString('base64');
  const response = await translationRequest(new Request('https://test', { method: 'POST', body: JSON.stringify({ audio, source: 'auto', target: 'en' }) }), ai);
  expect(response.status).toBe(413);
  expect(calls).toBe(0);
});
