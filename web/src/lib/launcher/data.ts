import { isDesktop } from '@/lib/desktop/bridge';
import { mockRecordings } from './mock';
import type { Recording } from './types';
import { isRecord, optionalString } from '@/lib/json';

function normalize(value: unknown): Recording | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const title = optionalString(value.title);
  return {
    id: value.id,
    title: title || 'Untitled recording',
    startedAt: numberValue(value.started_at_ms) ?? numberValue(value.startedAt) ?? 0,
    durationSec: numberValue(value.duration_sec) ?? numberValue(value.durationSec) ?? 0,
    source: normalizeSource(value.source),
    status: normalizeStatus(value.status),
    summary: optionalString(value.summary),
    transcript: optionalString(value.transcript),
    transcriptTruncated: value.transcript_truncated === true,
    revision: numberValue(value.revision),
    hasAudio: booleanValue(value.has_audio) ?? booleanValue(value.hasAudio) ?? false,
    hasVideo: booleanValue(value.has_video) ?? booleanValue(value.hasVideo) ?? false,
    device: optionalString(value.device),
  };
}

function normalizeSource(value: unknown): Recording['source'] {
  if (value === 'system' || value === 'mic' || value === 'both' || value === 'dictation' || value === 'upload' || value === 'screen' || value === 'screenshot' || value === 'note' || value === 'image') return value;
  if (value === 'import') return 'upload';
  if (value === 'mixed') return 'both';
  if (value === 'desktop') return 'both';
  return 'mic';
}

function normalizeStatus(value: unknown): Recording['status'] {
  if (value === 'recording' || value === 'processing' || value === 'complete' || value === 'failed' || value === 'transcript_failed') return value;
  if (value === 'queued' || value === 'uploading') return 'processing';
  return 'failed';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** The web palette's list (the desktop panel pages through the native history instead). */
export async function loadRecordings(now: number): Promise<Recording[]> {
  try {
    const res = await fetch('/api/meetings/list?limit=100', {
      headers: { accept: 'application/json' },
    });
    if (res.ok) {
      const body: unknown = await res.json();
      if (isRecord(body) && Array.isArray(body.items) && body.items.length) {
        const recordings = body.items
          .map(normalize)
          .filter((row): row is Recording => row !== null);
        if (recordings.length) return recordings;
      }
    }
  } catch {
    // ignore — offline or unauthenticated
  }

  return mockRecordings(now);
}

export interface RecordingPage {
  items: Recording[];
  nextOffset: number | null;
  counts: { all: number; voice: number; meetings: number; screens: number; notes: number };
}
interface NativePage {
  items: unknown[];
  next_offset: number | null;
  counts: RecordingPage['counts'];
}
function normalizeRows(rows: unknown[]): Recording[] {
  return rows.map(normalize).filter((row): row is Recording => row !== null);
}

export interface HistorySearch { client: string; generation: number }

export async function cancelHistorySearch(search: HistorySearch): Promise<void> {
  await window.__TAURI__?.core.invoke('cancel_history_search', { search });
}

export async function loadRecordingPage(offset = 0, query = '', filter = 'all', search?: HistorySearch): Promise<RecordingPage> {
  const t = window.__TAURI__;
  if (!t) throw new Error('Capture history is unavailable outside the desktop app');
  const page = await t.core.invoke<NativePage>('list_recordings', { offset, limit: 50, query, filter, ...(search ? { search } : {}) });
  return { items: normalizeRows(page.items), nextOffset: page.next_offset, counts: page.counts };
}

/** Copy/expand always asks for the current complete record, never its preview. */
export async function loadRecordingDetails(rec: Recording): Promise<Recording> {
  if (!isDesktop() || rec.detailsLoaded) return rec;
  const value = await window.__TAURI__!.core.invoke<unknown>('get_recording', { id: rec.id });
  const detail = normalize(value);
  if (!detail) throw new Error('That capture is no longer available');
  return { ...detail, detailsLoaded: true };
}

/** Refresh the loaded range in place, stopping early when deletions shorten it. */
export async function reloadRecordingPages(pages: number, query: string, filter: string, search?: HistorySearch): Promise<RecordingPage> {
  let next = await loadRecordingPage(0, query, filter, search);
  const items = [...next.items];
  const seen = new Set(items.map((row) => row.id));
  for (let i = 1; i < pages && next.nextOffset !== null; i++) {
    next = await loadRecordingPage(next.nextOffset, query, filter, search);
    for (const row of next.items) if (!seen.has(row.id)) { seen.add(row.id); items.push(row); }
  }
  return { ...next, items };
}
