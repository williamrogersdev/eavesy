import { describe, expect, test } from 'bun:test';
import type { TranscriptLine } from './transcript-player';
import { mergeTranslations, requestTranslations, toggleTranslation, translationFor } from './transcript-translation';

const line = (id: string, text: string, language = 'de'): TranscriptLine => ({ id, startMs: 0, endMs: 1, text, language });

describe('transcript translation', () => {
  test('the toggle shows and fetches untried lines, and hides without fetching', () => {
    expect(toggleTranslation(false, 3)).toEqual({ showing: true, load: true });
    expect(toggleTranslation(false, 0)).toEqual({ showing: true, load: false });
    expect(toggleTranslation(true, 3)).toEqual({ showing: false, load: false });
  });

  test('a null or empty translation falls back to the original line', () => {
    const sources = new Map([['a', 'Hallo'], ['b', 'Tschüss'], ['c', 'Danke']]);
    const done = mergeTranslations({}, sources, [['a', null], ['b', ''], ['c', 'Thanks'], ['zz', 'stray']]);
    expect(done).toEqual({ b: { source: 'Tschüss', text: '' }, c: { source: 'Danke', text: 'Thanks' } });
    expect(translationFor(done, line('a', 'Hallo'))).toBeUndefined();
    expect(translationFor(done, line('b', 'Tschüss'))).toBeUndefined();
    expect(translationFor(done, line('c', 'Danke'))).toBe('Thanks');
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

  test('pages until nothing remains', async () => {
    const pages = [{ lines: { a: 'Hi' }, remaining: 1 }, { lines: { b: 'Bye' }, remaining: 0 }];
    const urls: string[] = [];
    const seen: [string, unknown][][] = [];
    const result = await requestTranslations({
      meetingId: 'm1',
      target: 'en',
      onPage: (entries) => seen.push(entries),
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return Response.json(pages[urls.length - 1]);
      }) as unknown as typeof fetch,
    });
    expect(urls).toEqual(['/api/meetings/m1/translate', '/api/meetings/m1/translate']);
    expect(seen).toEqual([[['a', 'Hi']], [['b', 'Bye']]]);
    expect(result).toEqual({ ids: new Set(['a', 'b']), complete: true });
  });

  test('stops when a page adds no new lines and reports it did not finish', async () => {
    const pages = [{ lines: { a: 'Hi' }, remaining: 5 }, { lines: { b: 'Bye' }, remaining: 4 }, { lines: { b: 'Bye' }, remaining: 4 }];
    let calls = 0;
    const result = await requestTranslations({
      meetingId: 'm1',
      target: 'en',
      onPage: () => {},
      fetchImpl: (async () => Response.json(pages[calls++])) as unknown as typeof fetch,
    });
    expect(calls).toBe(3);
    expect(result).toEqual({ ids: new Set(['a', 'b']), complete: false });
  });
});
