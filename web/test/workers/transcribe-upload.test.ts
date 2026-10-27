import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Database } from '@cloudflare/workers-types';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Route as TranscribeRoute } from '../../src/routes/api/transcribe';

const testEnv = env as unknown as { DB: D1Database; TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

vi.mock('../../src/server/device-auth', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveIngestActor: async () => ({ userId: 'user_upload', isAnonymous: false }),
}));
const transcribed = vi.hoisted(() => ({ bytes: 0 }));
vi.mock('../../src/lib/transcription/transcribe-file', () => ({
  transcribeAudioFile: async ({ audio }: { audio: Uint8Array }) => {
    transcribed.bytes = audio.byteLength;
    return { text: 'ok', language: 'en', durationSec: 1 };
  },
}));

type RouteHandler = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>;
const post = (TranscribeRoute.options as unknown as { server: { handlers: { POST: RouteHandler } } }).server.handlers.POST;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('/api/transcribe large uploads', () => {
  // The desktop app sends whole clips as multipart (reqwest Form with an
  // "audio" part), and they can run well past 25 MB.
  it('accepts a 90 MB multipart upload', async () => {
    const audioBytes = 90 * 1024 * 1024;
    const boundary = 'eavesy-test-boundary';
    const encoder = new TextEncoder();
    const head = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
    );
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const chunk = new Uint8Array(1024 * 1024).fill(7);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(head);
      },
      pull(controller) {
        if (sent < audioBytes) {
          controller.enqueue(chunk);
          sent += chunk.byteLength;
        } else {
          controller.enqueue(tail);
          controller.close();
        }
      },
    });

    const response = await post({
      request: new Request('https://eavesy.test/api/transcribe', {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(head.byteLength + audioBytes + tail.byteLength),
        },
        body,
        duplex: 'half',
      } as RequestInit),
      params: {},
    });

    expect(await response.json()).toEqual({ text: 'ok', rawText: 'ok', repairStatus: 'unavailable', language: 'en', durationSec: 1 });
    expect(response.status).toBe(200);
    expect(transcribed.bytes).toBe(audioBytes);
  }, 60_000);
});
