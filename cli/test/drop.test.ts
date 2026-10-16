import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drop, findCredential, folderBaseName, parseStoredCredential } from '../src/drop';
import { appSettingsPath, getCapture, search } from '../src/store';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const NOW = new Date(2026, 9, 16, 9, 5);

type FetchCall = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, calls: FetchCall[] = []) {
  return Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json(body, { status });
    },
    { preconnect: () => {} },
  ) as unknown as typeof fetch;
}

describe('credentials', () => {
  test('a stored value is bound to the server that issued it', () => {
    expect(parseStoredCredential('https://eavesy.example.com/\neavesy_device_abc\n')).toEqual({
      base: 'https://eavesy.example.com',
      token: 'eavesy_device_abc',
    });
    expect(parseStoredCredential('eavesy_device_legacy')).toEqual({ base: 'https://eavesy.com', token: 'eavesy_device_legacy' });
    expect(parseStoredCredential('  ')).toBeNull();
  });

  test('tokens only go to https, or http on this machine', () => {
    expect(parseStoredCredential('http://eavesy.example.com\ntok')).toBeNull();
    expect(parseStoredCredential('http://localhost:3000\ntok')).toEqual({ base: 'http://localhost:3000', token: 'tok' });
    expect(() => findCredential({ env: { EAVESY_DEVICE_TOKEN: 't', EAVESY_API_BASE: 'http://evil.example' } })).toThrow('https');
  });

  test('env wins; otherwise the Keychain item for the app device id', () => {
    expect(findCredential({ env: { EAVESY_DEVICE_TOKEN: 't', EAVESY_API_BASE: 'http://localhost:3000/' } })).toEqual({
      base: 'http://localhost:3000',
      token: 't',
    });
    const home = tmp('eavesy-home-');
    mkdirSync(join(appSettingsPath(home), '..'), { recursive: true });
    writeFileSync(appSettingsPath(home), JSON.stringify({ device_id: 'dev-1' }));
    const asked: string[] = [];
    const credential = findCredential({
      env: {},
      home,
      readKeychain: (account) => {
        asked.push(account);
        return 'https://eavesy.com\nsecret';
      },
    });
    expect(asked).toEqual(['dev-1']);
    expect(credential).toEqual({ base: 'https://eavesy.com', token: 'secret' });
    expect(findCredential({ env: { EAVESY_NO_KEYCHAIN: '1' }, home, readKeychain: () => 'x' })).toBeNull();
    expect(findCredential({ env: {}, home: tmp('eavesy-empty-'), readKeychain: () => 'x' })).toBeNull();
  });
});

describe('drop', () => {
  test('signed in: text goes to /api/drops with the device token', async () => {
    const calls: FetchCall[] = [];
    const result = await drop(
      { kind: 'text', text: 'hello from an agent' },
      { root: tmp('eavesy-root-'), credential: { base: 'https://eavesy.com', token: 'tok' }, fetch: fakeFetch(201, { drop: { id: 'drp_1' } }, calls) },
    );
    expect(result).toEqual({ via: 'cloud', id: 'drp_1' });
    expect(calls[0].url).toBe('https://eavesy.com/api/drops');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ text: 'hello from an agent' });
  });

  test('signed in: files stream to /api/drops/upload with a filename', async () => {
    const dir = tmp('eavesy-src-');
    writeFileSync(join(dir, 'plan v2.pdf'), 'PDF');
    const calls: FetchCall[] = [];
    await drop(
      { kind: 'file', path: join(dir, 'plan v2.pdf') },
      { root: tmp('eavesy-root-'), credential: { base: 'https://eavesy.com', token: 'tok' }, fetch: fakeFetch(201, { drop: { id: 'drp_2' } }, calls) },
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe('https://eavesy.com/api/drops/upload');
    expect(headers['x-filename']).toBe('plan%20v2.pdf');
    expect(headers['content-type']).toBe('application/pdf');
    expect(headers['content-length']).toBe('3');
  });

  test('a refused credential falls back to the local folder and says why', async () => {
    const root = tmp('eavesy-root-');
    const result = await drop(
      { kind: 'text', text: 'offline idea' },
      { root, credential: { base: 'https://eavesy.com', token: 'old' }, fetch: fakeFetch(401, { error: 'unauthenticated' }), now: NOW },
    );
    expect(result.via).toBe('local');
    expect(result.note).toContain('HTTP 401');
    expect(getCapture(root, result.id!)?.text['note.md']).toBe('offline idea');
  });

  test('every cloud failure keeps the content locally and says why', async () => {
    const credential = { base: 'https://eavesy.com', token: 't' };
    const throwing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const timedOut = (async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;
    const cases: [typeof fetch, string][] = [
      [fakeFetch(403, { error: 'sign in to send drops' }), 'HTTP 403'],
      [fakeFetch(429, { error: 'slow down' }), 'HTTP 429: slow down'],
      [fakeFetch(413, { error: 'text too large' }), 'HTTP 413: text too large'],
      [fakeFetch(500, 'oops'), 'HTTP 500'],
      [throwing, 'could not reach https://eavesy.com (fetch failed)'],
      [timedOut, 'did not answer in time'],
    ];
    for (const [fetcher, why] of cases) {
      const root = tmp('eavesy-root-');
      const result = await drop({ kind: 'text', text: 'piped once' }, { root, credential, fetch: fetcher, now: NOW });
      expect(result.via).toBe('local');
      expect(result.note).toContain(why);
      expect(getCapture(root, result.id!)?.text['note.md']).toBe('piped once');
    }
  });

  test('an upload uses its own, longer timeout', async () => {
    const stalled = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const src = tmp('eavesy-src-');
    writeFileSync(join(src, 'deck.pdf'), 'PDF');
    const started = Date.now();
    const result = await drop(
      { kind: 'file', path: join(src, 'deck.pdf') },
      { root: tmp('eavesy-root-'), credential: { base: 'https://eavesy.com', token: 't' }, fetch: stalled, now: NOW, timeoutMs: { text: 10, upload: 150 } },
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(result.note).toContain('did not answer in time');
  });

  test('a 2xx without a drop id is still a success, with no made-up id', async () => {
    const odd = (async () => new Response('ok', { status: 201 })) as unknown as typeof fetch;
    const result = await drop({ kind: 'text', text: 'x' }, { root: tmp('r-'), credential: { base: 'https://eavesy.com', token: 't' }, fetch: odd });
    expect(result).toEqual({ via: 'cloud', id: undefined });
  });

  test('once a 2xx has arrived, a reply that stalls or breaks off is still a success', async () => {
    const replyThatNeverEnds = ((_url: string, init: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason));
        },
      });
      return Promise.resolve(new Response(stream, { status: 201 }));
    }) as unknown as typeof fetch;
    const replyThatBreaks = (async () =>
      new Response(new ReadableStream({ start: (c) => c.error(new TypeError('socket hang up')) }), { status: 201 })) as unknown as typeof fetch;
    const credential = { base: 'https://eavesy.com', token: 't' };
    const src = tmp('eavesy-src-');
    writeFileSync(join(src, 'deck.pdf'), 'PDF');

    // The upload path uses its own timeout: 150 ms here, not the text one.
    const started = Date.now();
    const upload = await drop({ kind: 'file', path: join(src, 'deck.pdf') }, { root: tmp('r-'), credential, fetch: replyThatNeverEnds, timeoutMs: { text: 10, upload: 150 } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(upload).toEqual({ via: 'cloud', id: undefined });

    const text = await drop({ kind: 'text', text: 'x' }, { root: tmp('r-'), credential, fetch: replyThatBreaks });
    expect(text).toEqual({ via: 'cloud', id: undefined });
  });

  test('a non-2xx reply that breaks off is still a refusal', async () => {
    const broken = (async () =>
      new Response(new ReadableStream({ start: (c) => c.error(new TypeError('socket hang up')) }), { status: 500 })) as unknown as typeof fetch;
    const result = await drop({ kind: 'text', text: 'x' }, { root: tmp('r-'), credential: { base: 'https://eavesy.com', token: 't' }, fetch: broken, now: NOW });
    expect(result.via).toBe('local');
    expect(result.note).toContain('HTTP 500');
  });

  test('authenticated requests never follow redirects', async () => {
    const calls: FetchCall[] = [];
    await drop({ kind: 'text', text: 'x' }, { root: tmp('r-'), credential: { base: 'https://eavesy.com', token: 't' }, fetch: fakeFetch(201, { drop: { id: 'd' } }, calls) });
    expect(calls[0].init.redirect).toBe('error');
  });

  test('a stalled server times out, keeps the text locally and says it may have arrived', async () => {
    const stalled = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const root = tmp('eavesy-root-');
    const result = await drop(
      { kind: 'text', text: 'slow network idea' },
      { root, credential: { base: 'https://eavesy.com', token: 't' }, fetch: stalled, now: NOW, timeoutMs: { text: 20, upload: 20 } },
    );
    expect(result.via).toBe('local');
    expect(result.note).toContain('may also have reached your devices');
    expect(getCapture(root, result.id!)?.text['note.md']).toBe('slow network idea');
  });

  test('an unreadable file is reported as itself, not as a network failure', async () => {
    await expect(
      drop({ kind: 'file', path: '/nonexistent/file.pdf' }, { root: tmp('r-'), credential: { base: 'https://eavesy.com', token: 't' }, fetch: fakeFetch(201, {}) }),
    ).rejects.toThrow('ENOENT');
  });

  test('a dropped file named like a manifest cannot replace it', async () => {
    const src = tmp('eavesy-src-');
    writeFileSync(join(src, 'CAPTURE.JSON'), '{"id":"evil"}');
    const root = tmp('eavesy-root-');
    const result = await drop({ kind: 'file', path: join(src, 'CAPTURE.JSON') }, { root, credential: null, now: NOW });
    expect(getCapture(root, result.id!)?.files.map((f) => f.name)).toEqual(['dropped-CAPTURE.JSON']);
    expect(getCapture(root, 'evil')).toBeNull();
  });

  test('not signed in: text becomes a note capture the CLI can find', async () => {
    const root = tmp('eavesy-root-');
    const first = await drop({ kind: 'text', text: 'Buy oat milk' }, { root, credential: null, now: NOW });
    const second = await drop({ kind: 'text', text: 'Buy oat milk again' }, { root, credential: null, now: NOW });
    expect(first.folder).toBe(join(root, '2026-10-16 Note'));
    expect(second.folder).toBe(join(root, '2026-10-16 Note (09-05)'));
    const manifest = JSON.parse(readFileSync(join(first.folder!, 'capture.json'), 'utf8'));
    expect(manifest).toMatchObject({ id: first.id, source: 'note', title: 'Note', started_at_ms: NOW.getTime(), origin: 'cli' });
    expect(search(root, 'oat milk').map((h) => h.capture.id).sort()).toEqual([first.id!, second.id!].sort());
  });

  test('not signed in: an image keeps its name and is an image capture', async () => {
    const src = tmp('eavesy-src-');
    writeFileSync(join(src, 'whiteboard.png'), 'png');
    const root = tmp('eavesy-root-');
    const result = await drop({ kind: 'file', path: join(src, 'whiteboard.png') }, { root, local: true, credential: { base: 'x', token: 'y' }, now: NOW });
    const capture = getCapture(root, result.id!)!;
    expect(capture).toMatchObject({ kind: 'image', title: 'whiteboard' });
    expect(capture.files.map((f) => f.name)).toEqual(['whiteboard.png']);
  });

  test('rejects empty text and directories', async () => {
    await expect(drop({ kind: 'text', text: '  ' }, { root: tmp('r-'), credential: null })).rejects.toThrow('empty');
    await expect(drop({ kind: 'file', path: tmp('d-') }, { root: tmp('r-'), credential: null })).rejects.toThrow('not a file');
  });

  test('folder names follow the app rules', () => {
    expect(folderBaseName('a/b: "c"  d', NOW)).toBe('2026-10-16 ab c d');
    expect(folderBaseName('日本', NOW)).toBe('2026-10-16 Recording');
  });
});
