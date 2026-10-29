import { describe, expect, test } from 'bun:test';
import type { Recording } from '@/lib/launcher/types';
import { askLabel, clock, countByFilter, dayLabel, filterOf, groupByDay, highlightParts, historyView, kindLabel, plainTranscript, reuseRows, sameRecording, searchFocusOpens, timeOfDay, visibleRecordings } from './history-model';

const NOW = new Date(2026, 9, 17, 15, 0).getTime();
const at = (daysAgo: number, hour = 10) => new Date(2026, 9, 17 - daysAgo, hour).getTime();
const rec = (id: string, source: Recording['source'], startedAt: number, transcript = ''): Recording => ({
  id, title: id, startedAt, durationSec: 30, source, status: 'complete', transcript, hasAudio: source !== 'note',
});

describe('history model', () => {
  const list = [
    rec('a', 'dictation', at(0), 'Remind Sam the deck goes out Thursday'),
    rec('b', 'both', at(0, 9), 'Weekly sync about the invoice'),
    rec('c', 'screenshot', at(1)),
    rec('d', 'note', at(3), 'Buy milk'),
    rec('e', 'mic', at(40)),
  ];

  test('filters by chip and searches transcripts', () => {
    expect(visibleRecordings(list, 'meetings', '').map((r) => r.id)).toEqual(['b']);
    expect(visibleRecordings(list, 'all', 'invoice').map((r) => r.id)).toEqual(['b']);
    expect(visibleRecordings(list, 'voice', 'deck').map((r) => r.id)).toEqual(['a']);
    expect(visibleRecordings(list, 'notes', 'deck')).toEqual([]);
    expect(countByFilter(list)).toEqual({ all: 5, voice: 2, meetings: 1, screens: 1, notes: 1 });
  });

  test('groups by day with friendly labels', () => {
    expect(dayLabel(at(0), NOW)).toBe('Today');
    expect(dayLabel(at(1), NOW)).toBe('Yesterday');
    expect(dayLabel(at(3), NOW)).toBe(new Date(at(3)).toLocaleDateString(undefined, { weekday: 'long' }));
    expect(groupByDay(visibleRecordings(list, 'all', ''), NOW).map((g) => [g.label, g.items.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      [dayLabel(at(3), NOW), 1],
      [dayLabel(at(40), NOW), 1],
    ]);
  });

  test('highlights matches without losing text', () => {
    expect(highlightParts('Send the Invoice today', 'invoice')).toEqual([
      { text: 'Send the ', hit: false },
      { text: 'Invoice', hit: true },
      { text: ' today', hit: false },
    ]);
    expect(highlightParts('a+b', '+')).toEqual([{ text: 'a', hit: false }, { text: '+', hit: true }, { text: 'b', hit: false }]);
  });

  test('formats clocks and transcripts', () => {
    expect(clock(42)).toBe('0:42');
    expect(clock(3725)).toBe('1:02:05');
    expect(plainTranscript('# Title\n\n## Transcript\n\n[00:00:01] hello')).toBe('hello');
  });
});

describe('history view state', () => {
  const page = (all: number) => ({ counts: { all } });
  test('is loading until the first page, never empty', () => {
    expect(historyView(null, null, false)).toBe('loading');
  });
  test('is empty only once a page says there is nothing', () => {
    expect(historyView(page(0), null, false)).toBe('empty');
    expect(historyView(page(3), null, false)).toBe('list');
  });
  test('a failed load is never the empty state', () => {
    expect(historyView(null, 'offline', false)).toBe('list');
    expect(historyView(page(0), 'offline', false)).toBe('list');
  });
  test('a running capture keeps the list in place', () => {
    expect(historyView(page(0), null, true)).toBe('list');
    expect(historyView(null, null, true)).toBe('list');
  });
});

describe('row identity across refreshes', () => {
  const a = rec('a', 'dictation', at(0), 'one');
  const b = rec('b', 'note', at(0, 9), 'two');
  test('keeps unchanged rows, and the list itself when nothing changed', () => {
    const previous = [a, b];
    const same = reuseRows(previous, [{ ...a }, { ...b }]);
    expect(same).toBe(previous);
  });
  test('replaces only the row that changed', () => {
    const changed = { ...b, transcript: 'two, refined', revision: 2 };
    const next = reuseRows([a, b], [{ ...a }, changed]);
    expect(next[0]).toBe(a);
    expect(next[1]).toBe(changed);
  });
  test('a new row at the top keeps the others', () => {
    const c = rec('c', 'mic', at(0, 11));
    const next = reuseRows([a, b], [c, { ...a }, { ...b }]);
    expect(next.map((row) => row.id)).toEqual(['c', 'a', 'b']);
    expect(next[1]).toBe(a);
    expect(next[2]).toBe(b);
  });
  test('compares every field, not just the revision', () => {
    expect(sameRecording(a, { ...a })).toBe(true);
    expect(sameRecording({ ...a, revision: 1 }, { ...a, revision: 1, status: 'processing' })).toBe(false);
    expect(sameRecording(a, { ...a, device: 'iPhone' })).toBe(false);
  });
});

describe('kinds', () => {
  test('one table names the kind and picks the filter', () => {
    expect(kindLabel(rec('a', 'dictation', 0))).toBe('Voice note');
    expect(kindLabel(rec('a', 'system', 0))).toBe('Meeting');
    expect(kindLabel({ ...rec('a', 'upload', 0), title: 'Interview.m4a' })).toBe('Interview.m4a');
    expect(filterOf(rec('a', 'image', 0))).toBe('screens');
    expect(filterOf({ ...rec('a', 'upload', 0), hasVideo: true })).toBe('screens');
    expect(filterOf(rec('a', 'upload', 0))).toBe('voice');
  });

  test('an attached capture is named by kind and time, with the day unless it is today', () => {
    const today = rec('a', 'dictation', at(0, 9));
    expect(askLabel(today, NOW)).toBe(`Voice note · ${timeOfDay(today.startedAt)}`);
    const yesterday = rec('b', 'system', at(1, 9));
    expect(askLabel(yesterday, NOW)).toBe(`Meeting · Yesterday ${timeOfDay(yesterday.startedAt)}`);
  });
});

describe('searchFocusOpens', () => {
  test('"/" opens search wherever focus came from', () => {
    expect(searchFocusOpens({ asked: true, quiet: false, fromElement: false })).toBe(true);
  });
  test('Tab or a closing filter menu opens it', () => {
    expect(searchFocusOpens({ asked: false, quiet: false, fromElement: true })).toBe(true);
  });
  test('the quiet focus on open leaves it an icon', () => {
    expect(searchFocusOpens({ asked: false, quiet: true, fromElement: true })).toBe(false);
    expect(searchFocusOpens({ asked: false, quiet: true, fromElement: false })).toBe(false);
  });
  test('the window getting focus back leaves it an icon', () => {
    expect(searchFocusOpens({ asked: false, quiet: false, fromElement: false })).toBe(false);
  });
});
