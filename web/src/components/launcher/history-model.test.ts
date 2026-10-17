import { describe, expect, test } from 'bun:test';
import type { Recording } from '@/lib/launcher/types';
import { clock, countByFilter, dayLabel, groupByDay, highlightParts, plainTranscript, visibleRecordings } from './history-model';

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
