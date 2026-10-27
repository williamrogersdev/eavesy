import { describe, expect, test } from 'bun:test';
import type { TranscriptLine } from './transcript-player';
import { mergeTranslations, requestTranslations, spokenLanguages, translationFor } from './transcript-translation';

const line = (id: string, text: string, language = 'de'): TranscriptLine => ({ id, startMs: 0, endMs: 1, text, language });

const pagesOf = (pages: unknown[]) => {
  let calls = 0;
  const fetchImpl = (async () => Response.json(pages[calls++])) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
};

describe('transcript translation', () => {
  test('spoken languages are ordered by how much was said in each', () => {
    expect(spokenLanguages([line('a', 'Hallo', 'de'), line('b', 'Hello there everyone', 'en'), line('c', 'x', '')])).toEqual(['en', 'de']);
  });

  test('a blank translation falls back to the original line, and stray ids are ignored', () => {
    const sources = new Map([['b', 'Tschüss'], ['c', 'Danke'], ['d', 'Ja']]);
    const done = mergeTranslations({}, sources, [['b', '  '], ['c', 'Thanks'], ['d', 'Ja'], ['zz', 'stray']]);
    expect(Object.keys(done).sort()).toEqual(['b', 'c', 'd']);
    expect(translationFor(done, line('b', 'Tschüss'))).toBeUndefined();
    expect(translationFor(done, line('c', 'Danke'))).toBe('Thanks');
    expect(translationFor(done, line('d', 'Ja'))).toBeUndefined();
  });

  test('an edited line shows the original until it is translated again', () => {
    const done = mergeTranslations({}, new Map([['c', 'Danke']]), [['c', 'Thanks']]);
    expect(translationFor(done, line('c', 'Danke schön'))).toBeUndefined();
  });

  test('a failed request reports why', async () => {
    const reply = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    const run = (status: number) => requestTranslations({ meetingId: 'm1', target: 'en', onPage: () => {}, fetchImpl: reply(status) });
    await expect(run(429)).rejects.toThrow('Translation limit reached for today.');
    await expect(run(500)).rejects.toThrow('Could not translate.');
  });

  test('a malformed reply is an error', async () => {
    const { fetchImpl } = pagesOf([{ lines: ['a'], remaining: 0 }]);
    await expect(requestTranslations({ meetingId: 'm1', target: 'en', onPage: () => {}, fetchImpl })).rejects.toThrow('Could not read the translation.');
  });

  test('pages until nothing remains, skipping non-string lines', async () => {
    const urls: string[] = [];
    const seen: [string, string][][] = [];
    const pages = [{ lines: { a: 'Hi', x: null }, remaining: 1 }, { lines: { a: 'Hi', b: 'Bye' }, remaining: 0 }];
    await requestTranslations({
      meetingId: 'm1',
      target: 'en',
      onPage: (entries) => seen.push(entries),
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return Response.json(pages[urls.length - 1]);
      }) as unknown as typeof fetch,
    });
    expect(urls).toEqual(['/api/meetings/m1/translate', '/api/meetings/m1/translate']);
    expect(seen).toEqual([[['a', 'Hi']], [['a', 'Hi'], ['b', 'Bye']]]);
  });

  test('a page that adds nothing stops with a retry hint', async () => {
    const { fetchImpl, calls } = pagesOf([
      { lines: { a: 'Hi' }, remaining: 5 },
      { lines: { a: 'Hi', b: 'Bye' }, remaining: 4 },
      { lines: { a: 'Hi', b: 'Bye' }, remaining: 4 },
    ]);
    const seen: number[] = [];
    await expect(
      requestTranslations({ meetingId: 'm1', target: 'en', onPage: (entries) => seen.push(entries.length), fetchImpl }),
    ).rejects.toThrow('Translation stopped early. Choose the language again to retry.');
    expect(calls()).toBe(3);
    expect(seen).toEqual([1, 2, 2]);
  });

  test('a cancelled run keeps nothing from the page in flight', async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => {
      controller.abort();
      return Response.json({ lines: { a: 'Hi' }, remaining: 0 });
    }) as unknown as typeof fetch;
    let pages = 0;
    await requestTranslations({ meetingId: 'm1', target: 'en', signal: controller.signal, onPage: () => pages++, fetchImpl });
    expect(pages).toBe(0);
  });
});
