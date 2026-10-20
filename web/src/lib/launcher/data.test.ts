import { afterEach, expect, test } from 'bun:test';
import { loadRecordingDetails, loadRecordingPage, loadRecordings } from './data';
import type { Recording } from './types';
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
const native = { id: 'a', title: 'Meeting', started_at_ms: 123, duration_sec: 3600, source: 'mixed', status: 'complete', has_audio: true, transcript: 'Preview', transcript_truncated: true, revision: 3 };
const rec: Recording = { id: 'a', title: 'Meeting', startedAt: 123, durationSec: 3600, source: 'both', status: 'complete', hasAudio: true, transcript: 'Preview', transcriptTruncated: true, revision: 3 };
function install(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI__: { core: { invoke } } } });
}

test('history requests a bounded page and forwards full-history search and filters', async () => {
  const calls: unknown[] = [];
  install(async (cmd, args) => { calls.push({ cmd, args }); return { items: [native], next_offset: 100, counts: { all: 1000, voice: 0, meetings: 1000, screens: 0, notes: 0 } }; });
  const page = await loadRecordingPage(50, 'deep transcript words', 'meetings');
  expect(calls).toEqual([{ cmd: 'list_recordings', args: { offset: 50, limit: 50, query: 'deep transcript words', filter: 'meetings' } }]);
  expect(page.nextOffset).toBe(100);
  expect(page.counts.all).toBe(1000);
  expect(page.items[0]).toMatchObject(rec);
  expect(page.items[0].detailsLoaded).not.toBe(true);
  expect(await loadRecordings(0)).toHaveLength(1);
});

test('details retrieve the complete transcript for copy and expansion', async () => {
  const full = `Preview${' full words'.repeat(1000)} tailword`;
  install(async (cmd, args) => { expect(cmd).toBe('get_recording'); expect(args).toEqual({ id: 'a' }); return { ...native, transcript: full, transcript_truncated: false, summary: 'Full summary' }; });
  const detail = await loadRecordingDetails(rec);
  expect(detail.transcript).toBe(full);
  expect(detail.summary).toBe('Full summary');
  expect(detail.detailsLoaded).toBe(true);
});

test('a deleted record errors instead of copying its truncated preview', async () => {
  install(async () => null);
  await expect(loadRecordingDetails(rec)).rejects.toThrow('no longer available');
});
