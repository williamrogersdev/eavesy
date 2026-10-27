import { describe, expect, test } from 'bun:test';
import { formatBytes, formatDuration, meetingFolderSlug } from './utils';

describe('formatDuration', () => {
  test('renders mm:ss under an hour', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(5_000)).toBe('00:05');
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(3_599_000)).toBe('59:59');
  });

  test('renders h:mm:ss from an hour', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_661_000)).toBe('1:01:01');
    expect(formatDuration(36_005_000)).toBe('10:00:05');
  });

  test('drops sub-second remainders', () => {
    expect(formatDuration(999)).toBe('00:00');
    expect(formatDuration(59_999)).toBe('00:59');
    expect(formatDuration(3_599_999)).toBe('59:59');
  });
});

describe('formatBytes', () => {
  test('renders bytes below 1024', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  test('renders whole KB below 1 MiB', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(512_000)).toBe('500 KB');
  });

  test('renders one-decimal MB from 1 MiB', () => {
    expect(formatBytes(1_048_576)).toBe('1.0 MB');
    expect(formatBytes(1_572_864)).toBe('1.5 MB');
  });

  test('never shows 1024 KB just below 1 MiB', () => {
    expect(formatBytes(1_047_552)).toBe('1023 KB');
    expect(formatBytes(1_048_064)).toBe('1.0 MB');
    expect(formatBytes(1_048_575)).toBe('1.0 MB');
  });
});

describe('meetingFolderSlug', () => {
  const at = new Date('2026-03-04T23:30:00Z');

  test('starts with the UTC date, then the title', () => {
    expect(meetingFolderSlug('Weekly sync', at)).toBe('2026-03-04 Weekly sync');
    expect(meetingFolderSlug('Late', new Date('2026-03-04T23:59:59-05:00'))).toBe('2026-03-05 Late');
  });

  test('removes characters file systems reject', () => {
    expect(meetingFolderSlug('a/b\\c:d*e?f"g<h>i|j', at)).toBe('2026-03-04 abcdefghij');
    expect(meetingFolderSlug('Q1 / Q2: plan', at)).toBe('2026-03-04 Q1 Q2 plan');
  });

  test('folds accents and removes other non-ASCII', () => {
    expect(meetingFolderSlug('Café', at)).toBe('2026-03-04 Cafe');
    expect(meetingFolderSlug('Ångström 会議 🎉 review', at)).toBe('2026-03-04 Angstrom review');
  });

  test('collapses whitespace, including tabs and newlines, and trims', () => {
    expect(meetingFolderSlug('  Team   sync  ', at)).toBe('2026-03-04 Team sync');
    expect(meetingFolderSlug('Team\tsync\nnotes', at)).toBe('2026-03-04 Team sync notes');
    expect(meetingFolderSlug('Team sync', at)).toBe('2026-03-04 Team sync');
  });

  test('cuts long titles to 80 characters without a trailing space', () => {
    expect(meetingFolderSlug('x'.repeat(120), at)).toBe(`2026-03-04 ${'x'.repeat(80)}`);
    expect(meetingFolderSlug(`${'x'.repeat(79)} tail`, at)).toBe(`2026-03-04 ${'x'.repeat(79)}`);
  });

  test('falls back to Recording when nothing is left', () => {
    expect(meetingFolderSlug('', at)).toBe('2026-03-04 Recording');
    expect(meetingFolderSlug('  /:*?  ', at)).toBe('2026-03-04 Recording');
    expect(meetingFolderSlug('会議', at)).toBe('2026-03-04 Recording');
  });
});
