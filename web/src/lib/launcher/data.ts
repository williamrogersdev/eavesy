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
    hasAudio: booleanValue(value.has_audio) ?? booleanValue(value.hasAudio) ?? false,
    hasVideo: booleanValue(value.has_video) ?? booleanValue(value.hasVideo) ?? false,
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

export async function loadRecordings(now: number): Promise<Recording[]> {
  if (isDesktop()) {
    try {
      const { core } = window.__TAURI__!;
      const rows = await core.invoke<unknown[]>('list_recordings');
      return (rows ?? []).map(normalize).filter((row): row is Recording => row !== null);
    } catch {
      return [];
    }
  }

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
