import { afterEach, describe, expect, test } from 'bun:test';
import { archiveFormatForMime, SessionUpload } from '@/lib/audio/session-upload';

const MiB = 1024 * 1024;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  method: string;
  path: string;
  bytes: number;
  headers: Headers;
}

function fakeServer(fail: (call: Call) => number | null = () => null) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    const bytes = body instanceof Blob ? body.size : typeof body === 'string' ? body.length : 0;
    const call = { method: init?.method ?? 'GET', path: String(input), bytes, headers: new Headers(init?.headers) };
    calls.push(call);
    const status = fail(call);
    if (status) return Response.json({ error: `status ${status}` }, { status });
    if (call.path === '/api/sessions') return Response.json({ meetingId: 'meet_1' }, { status: 201 });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return calls;
}

const segment = (idx: number) => ({
  idx,
  blob: new Blob([new Uint8Array(10)], { type: 'audio/webm' }),
  startMs: idx * 240_000,
  durationMs: 240_000,
});

describe('SessionUpload', () => {
  test('creates the session, streams segments and 8 MiB parts in order, then finalizes the rest', async () => {
    const calls = fakeServer();
    const upload = new SessionUpload('audio/webm;codecs=opus', []);
    upload.addArchiveChunk(new Blob([new Uint8Array(5 * MiB)]));
    upload.addSegment(segment(0));
    upload.addArchiveChunk(new Blob([new Uint8Array(5 * MiB)]));
    await upload.finish();

    expect(calls.map((c) => `${c.method} ${c.path} ${c.bytes}`)).toEqual([
      `POST /api/sessions ${calls[0].bytes}`,
      'PUT /api/sessions/meet_1/segments/0 10',
      `PUT /api/sessions/meet_1/parts/1 ${8 * MiB}`,
      `POST /api/sessions/meet_1/finalize ${2 * MiB}`,
    ]);
    expect(calls[1].headers.get('x-segment-start-ms')).toBe('0');
    expect(calls[1].headers.get('x-segment-duration-ms')).toBe('240000');
    expect(upload.meetingId).toBe('meet_1');
  });

  test('keeps a byte back so the final part is never empty', async () => {
    const calls = fakeServer();
    const upload = new SessionUpload('audio/webm', []);
    upload.addArchiveChunk(new Blob([new Uint8Array(8 * MiB)]));
    await upload.finish();
    expect(calls.filter((c) => c.path.includes('/parts/'))).toHaveLength(0);
    expect(calls.at(-1)?.bytes).toBe(8 * MiB);
  });

  test('a failed upload resumes from where it stopped on the next finish', async () => {
    let down = true;
    const calls = fakeServer((call) => (down && call.path.includes('/segments/1') ? 503 : null));
    const upload = new SessionUpload('audio/webm', [0]);
    upload.addArchiveChunk(new Blob([new Uint8Array(100)]));
    upload.addSegment(segment(0));
    upload.addSegment(segment(1));
    upload.addSegment(segment(2));

    await expect(upload.finish()).rejects.toThrow('status 503');
    expect(calls.some((c) => c.path.includes('/segments/2'))).toBe(false);

    down = false;
    await upload.finish();
    const uploaded = calls.filter((c) => c.method !== 'POST' || c.path.endsWith('finalize')).map((c) => c.path);
    expect(uploaded).toEqual([
      '/api/sessions/meet_1/segments/0',
      '/api/sessions/meet_1/segments/1',
      '/api/sessions/meet_1/segments/1',
      '/api/sessions/meet_1/segments/1',
      '/api/sessions/meet_1/segments/2',
      '/api/sessions/meet_1/finalize',
    ]);
  });

  test('client errors are not retried', async () => {
    const calls = fakeServer((call) => (call.path === '/api/sessions' ? 401 : null));
    const upload = new SessionUpload('audio/webm', [0, 0, 0]);
    upload.addArchiveChunk(new Blob([new Uint8Array(1)]));
    await expect(upload.finish()).rejects.toThrow('status 401');
    expect(calls).toHaveLength(1);
  });

  test('keeps audio that arrives before the recording has started', async () => {
    const calls = fakeServer();
    const upload = new SessionUpload(null, []);
    upload.addArchiveChunk(new Blob([new Uint8Array(3)]));
    upload.addSegment(segment(0));
    await Promise.resolve();
    expect(calls).toHaveLength(0);

    upload.begin('audio/webm');
    await upload.finish();
    expect(calls.map((c) => `${c.method} ${c.path} ${c.bytes}`)).toEqual([
      `POST /api/sessions ${calls[0].bytes}`,
      'PUT /api/sessions/meet_1/segments/0 10',
      'POST /api/sessions/meet_1/finalize 3',
    ]);
  });

  test('never addresses a session that was not created', async () => {
    const calls = fakeServer((call) => (call.path === '/api/sessions' ? 503 : null));
    const upload = new SessionUpload('audio/webm', []);
    upload.addSegment(segment(0));
    await expect(upload.finish()).rejects.toThrow('status 503');
    await upload.discard();
    upload.addSegment(segment(1));
    upload.addArchiveChunk(new Blob([new Uint8Array(9 * MiB)]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((c) => c.path.includes('null'))).toEqual([]);
    expect(calls.every((c) => c.path === '/api/sessions')).toBe(true);
  });

  test('discarding deletes the recording', async () => {
    const calls = fakeServer();
    const upload = new SessionUpload('audio/webm', []);
    await upload.finish().catch(() => undefined);
    await upload.discard();
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/meetings/meet_1' });
  });
});

test('archive formats follow the MediaRecorder container', () => {
  expect(archiveFormatForMime('audio/webm;codecs=opus')).toBe('webm');
  expect(archiveFormatForMime('audio/ogg;codecs=opus')).toBe('opus');
  expect(archiveFormatForMime('audio/mp4')).toBe('m4a');
});
