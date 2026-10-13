'use client';

import { useEffect, useState } from 'react';
import { createResource } from './shared-resource';

export interface CaptureItem {
  id: string;
  kind: 'image' | 'video' | 'audio';
  captureMode: 'screenshot' | 'webcam' | 'screen' | 'audio';
  title: string;
  url: string;
  contentType: string;
  bytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  transcript: string | null;
  transcriptStatus: 'none' | 'pending' | 'processing' | 'complete' | 'failed';
  transcriptError: string | null;
  createdAt: number;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('Request failed');
}

export const captureList = createResource('/api/captures', parseCaptureList);

export function useCaptures() {
  return captureList.use();
}

export function useCapture(id: string) {
  const [data, setData] = useState<CaptureItem | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/captures/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'Capture not found' : `Server returned ${r.status}`);
        const json: unknown = await r.json();
        return json;
      })
      .then((json) => {
        const capture = parseCaptureItem(json);
        if (!capture) throw new Error('Server returned an invalid capture');
        if (!cancelled) setData(capture);
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(asError(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return { data, loading, error };
}

function parseCaptureList(value: unknown): CaptureItem[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  return value.items.flatMap((item) => {
    const capture = parseCaptureItem(item);
    return capture ? [capture] : [];
  });
}

function parseCaptureItem(value: unknown): CaptureItem | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    !isCaptureKind(value.kind) ||
    !isCaptureMode(value.captureMode) ||
    typeof value.title !== 'string' ||
    typeof value.url !== 'string' ||
    typeof value.contentType !== 'string' ||
    typeof value.bytes !== 'number' ||
    !isTranscriptStatus(value.transcriptStatus) ||
    typeof value.createdAt !== 'number'
  ) {
    return null;
  }
  return {
    id: value.id,
    kind: value.kind,
    captureMode: value.captureMode,
    title: value.title,
    url: value.url,
    contentType: value.contentType,
    bytes: value.bytes,
    durationSec: nullableNumber(value.durationSec),
    width: nullableNumber(value.width),
    height: nullableNumber(value.height),
    transcript: nullableString(value.transcript),
    transcriptStatus: value.transcriptStatus,
    transcriptError: nullableString(value.transcriptError),
    createdAt: value.createdAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCaptureKind(value: unknown): value is CaptureItem['kind'] {
  return value === 'image' || value === 'video' || value === 'audio';
}

function isCaptureMode(value: unknown): value is CaptureItem['captureMode'] {
  return value === 'screenshot' || value === 'webcam' || value === 'screen' || value === 'audio';
}

function isTranscriptStatus(value: unknown): value is CaptureItem['transcriptStatus'] {
  return value === 'none' || value === 'pending' || value === 'processing' || value === 'complete' || value === 'failed';
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
