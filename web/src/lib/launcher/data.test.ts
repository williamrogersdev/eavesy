import { afterEach, expect, test } from 'bun:test';
import { loadRecordingDetails, loadRecordingPage, loadRecordings, reloadRecordingPages } from './data';
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


test('background refresh reloads every loaded page and retains deep rows', async () => {
  const offsets: unknown[] = [];
  install(async (_cmd, args) => { offsets.push(args?.offset); return { items: [{ ...native, id: args?.offset === 0 ? 'newest' : 'older' }], next_offset: args?.offset === 0 ? 50 : null, counts: { all: 51, voice: 0, meetings: 51, screens: 0, notes: 0 } }; });
  const page = await reloadRecordingPages(2, '', 'all');
  expect(offsets).toEqual([0, 50]);
  expect(page.items.map((row) => row.id)).toEqual(['newest', 'older']);
  expect(page.nextOffset).toBeNull();
});

test('refresh stops when deletions remove later pages', async () => {
  let requests = 0;
  install(async () => { requests++; return { items: [native], next_offset: null, counts: { all: 1, voice: 0, meetings: 1, screens: 0, notes: 0 } }; });
  expect((await reloadRecordingPages(3, '', 'all')).items).toHaveLength(1);
  expect(requests).toBe(1);
});


test('a failed later page rejects the refresh instead of replacing the existing list with a partial range', async () => {
  install(async (_cmd, args) => {
    if (args?.offset === 50) throw new Error('Database unavailable');
    return { items: [native], next_offset: 50, counts: { all: 100, voice: 0, meetings: 100, screens: 0, notes: 0 } };
  });
  await expect(reloadRecordingPages(2, '', 'all')).rejects.toThrow('Database unavailable');
});
