import { describe, expect, test } from 'bun:test';
import type { RecordingPage } from '@/lib/launcher/data';
import type { Recording } from '@/lib/launcher/types';
import { appendPage, mergePage, REFRESH_DEBOUNCE_MS, reloadDelay, SEARCH_DEBOUNCE_MS } from './use-history-page';

const row = (id: string, over: Partial<Recording> = {}): Recording => ({
  id, title: id, startedAt: 1, durationSec: 0, source: 'note', status: 'complete', hasAudio: false, revision: 1, ...over,
});
const counts = { all: 2, voice: 0, meetings: 0, screens: 0, notes: 2 };
const page = (items: Recording[], nextOffset: number | null = null, c = counts): RecordingPage => ({ items, nextOffset, counts: c });

describe('history reload timing', () => {
  test('the first load and Try again run at once', () => {
    expect(reloadDelay('initial', '')).toBe(0);
    expect(reloadDelay('wake', 'deck')).toBe(0);
  });
  test('typing waits a beat; picking a filter does not', () => {
    expect(reloadDelay('selection', 'deck')).toBe(SEARCH_DEBOUNCE_MS);
    expect(reloadDelay('selection', '  ')).toBe(0);
  });
  test('a burst of native refreshes shares one debounced reload', () => {
    expect(reloadDelay('refresh', '')).toBe(REFRESH_DEBOUNCE_MS);
    expect(reloadDelay('refresh', 'deck')).toBe(REFRESH_DEBOUNCE_MS);
  });
});

describe('merging a reloaded page', () => {
  const a = row('a');
  const b = row('b');
  test('an unchanged reload keeps the page object, so nothing re-renders', () => {
    const previous = page([a, b]);
    expect(mergePage(previous, page([{ ...a }, { ...b }]))).toBe(previous);
  });
  test('keeps unchanged rows and takes the changed one', () => {
    const refined = row('b', { revision: 2, transcript: 'better' });
    const next = mergePage(page([a, b]), page([{ ...a }, refined]));
    expect(next.items[0]).toBe(a);
    expect(next.items[1]).toBe(refined);
  });
  test('new counts or a new next page come through', () => {
    const previous = page([a, b]);
    expect(mergePage(previous, page([{ ...a }, { ...b }], 50)).nextOffset).toBe(50);
    const more = { ...counts, all: 3, notes: 3 };
    expect(mergePage(previous, page([{ ...a }, { ...b }], null, more)).counts).toEqual(more);
  });
  test('without a previous page it is the reload itself', () => {
    const next = page([a]);
    expect(mergePage(null, next)).toBe(next);
  });
});

describe('appending a page', () => {
  test('skips rows already shown and takes the newer next offset', () => {
    const a = row('a');
    const joined = appendPage(page([a], 1), page([{ ...a }, row('c')], 2));
    expect(joined.items.map((r) => r.id)).toEqual(['a', 'c']);
    expect(joined.items[0]).toBe(a);
    expect(joined.nextOffset).toBe(2);
  });
});
