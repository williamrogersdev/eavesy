import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSettingsPath, getCapture, listCaptures, recent, resolveRoot, search } from '../src/store';

export const FIXTURE = join(import.meta.dir, 'fixtures', 'Recordings');
const SCREENSHOT_ID = '5b9e1c7a-0d2f-4a8e-9c1b-2f6d3e4a5b6c';
const NOTE_ID = '0c8f6c2e-1d9a-4f53-8a57-3b1f0e6d9a11';

describe('listCaptures', () => {
  test('reads meeting.json and capture.json folders, newest first, and skips the rest', () => {
    const captures = listCaptures(FIXTURE);
    expect(captures.map((c) => [c.id, c.kind])).toEqual([
      [SCREENSHOT_ID, 'screenshot'],
      ['7a1d2b3c-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'image'],
      [NOTE_ID, 'note'],
      ['meeting-pending', 'meeting'],
      ['meeting-design-review', 'meeting'],
    ]);
  });

  test('maps meeting metadata', () => {
    const meeting = listCaptures(FIXTURE).find((c) => c.id === 'meeting-design-review')!;
    expect(meeting.title).toBe('Design review');
    expect(meeting.date).toBe('2026-06-15T15:00:00.000Z');
    expect(meeting.durationSeconds).toBe(1820);
    expect(meeting.files.map((f) => [f.name, f.role])).toEqual([
      ['audio.m4a', 'media'],
      ['notes.md', 'text'],
      ['summary.md', 'text'],
      ['transcript.md', 'text'],
    ]);
  });

  test('a missing root is empty, not an error', () => {
    expect(listCaptures(join(FIXTURE, 'nope'))).toEqual([]);
  });
});

describe('recent', () => {
  test('filters by kind and limits', () => {
    expect(recent(FIXTURE, { kind: 'meeting' }).map((c) => c.id)).toEqual(['meeting-pending', 'meeting-design-review']);
    expect(recent(FIXTURE, { limit: 2 })).toHaveLength(2);
  });
});

describe('getCapture', () => {
  test('by id returns the text files without processing placeholders', () => {
    const pending = getCapture(FIXTURE, 'meeting-pending')!;
    expect(pending.text).toEqual({});
    const review = getCapture(FIXTURE, 'meeting-design-review')!;
    expect(Object.keys(review.text)).toEqual(['notes.md', 'summary.md', 'transcript.md']);
    expect(review.text['summary.md']).toContain('onboarding checklist');
  });

  test('by folder name and by unambiguous id prefix', () => {
    expect(getCapture(FIXTURE, '2026-07-01 Note')?.id).toBe(NOTE_ID);
    expect(getCapture(FIXTURE, '5b9e1c7a')?.id).toBe(SCREENSHOT_ID);
    expect(getCapture(FIXTURE, '5b9e')).toBeNull();
    expect(getCapture(FIXTURE, 'Random folder')).toBeNull();
    expect(getCapture(FIXTURE, '')).toBeNull();
  });
});

describe('search', () => {
  test('finds clipboard notes that never upload', () => {
    const hits = search(FIXTURE, 'webhook secret');
    expect(hits.map((h) => h.capture.id)).toEqual([NOTE_ID]);
    expect(hits[0].matchedIn).toBe('note.md');
    expect(hits[0].snippet).toContain('staging webhook secret');
  });

  test('every term must match; title hits rank first', () => {
    expect(search(FIXTURE, 'checklist').map((h) => h.capture.id)).toEqual(['meeting-design-review', NOTE_ID]);
    expect(search(FIXTURE, 'checklist flag').map((h) => h.capture.id)).toEqual(['meeting-design-review']);
    expect(search(FIXTURE, 'design').map((h) => h.matchedIn)).toEqual(['summary.md']);
    expect(search(FIXTURE, 'nothing-matches-this')).toEqual([]);
    expect(search(FIXTURE, '   ')).toEqual([]);
  });

  test('is case-insensitive and honours --kind', () => {
    expect(search(FIXTURE, 'WEBHOOK', { kind: 'meeting' })).toEqual([]);
    expect(search(FIXTURE, 'screenshot', { kind: 'screenshot' }).map((h) => h.capture.id)).toEqual([SCREENSHOT_ID]);
  });
});

describe('resolveRoot', () => {
  const home = mkdtempSync(join(tmpdir(), 'eavesy-home-'));

  test('defaults to ~/Eavesy/Recordings', () => {
    expect(resolveRoot({ env: {}, home })).toBe(join(home, 'Eavesy', 'Recordings'));
  });

  test("uses the app's recordings folder, then env, then --root", () => {
    mkdirSync(join(appSettingsPath(home), '..'), { recursive: true });
    writeFileSync(appSettingsPath(home), JSON.stringify({ recordings_root: '/Volumes/Notes/Eavesy' }));
    expect(resolveRoot({ env: {}, home })).toBe('/Volumes/Notes/Eavesy');
    expect(resolveRoot({ env: { EAVESY_RECORDINGS: '~/Elsewhere' }, home })).toBe(join(home, 'Elsewhere'));
    expect(resolveRoot({ env: { EAVESY_RECORDINGS: '/x' }, home, root: '/y' })).toBe('/y');
  });
});
