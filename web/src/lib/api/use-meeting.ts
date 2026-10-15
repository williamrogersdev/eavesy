'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createResource } from './shared-resource';
import type { TranscriptRange } from '@/lib/transcription/live-transcript';
import { ANONYMOUS_TOKEN_STORAGE_KEY } from '@/lib/runtime';

export interface UseMeetingResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  /** Changes the loaded data in place, e.g. to apply a live transcript delta. */
  mutate: (update: (current: T) => T) => void;
}

interface UseMeetingOptions<T> {
  pollMs?: number;
  shouldPoll?: (data: T) => boolean;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('Request failed');
}

export function useMeeting<T = unknown>(
  meetingId: string,
  opts: UseMeetingOptions<T> = {},
): UseMeetingResult<T> {
  const { pollMs, shouldPoll } = opts;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const dataRef = useRef<T | null>(null);
  const meetingIdRef = useRef(meetingId);

  useEffect(() => {
    let cancelled = false;
    if (meetingIdRef.current !== meetingId) {
      meetingIdRef.current = meetingId;
      dataRef.current = null;
      setData(null);
    }
    if (dataRef.current === null) {
      setLoading(true);
      setError(null);
    }

    fetch(meetingUrl(meetingId).toString())
      .then(async (r) => {
        if (!r.ok) throw new Error(`Server returned ${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (!cancelled) {
          const next = json as T;
          dataRef.current = next;
          setData(next);
          setError(null);
        }
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
  }, [meetingId, tick]);

  useEffect(() => {
    if (!pollMs || data === null || (shouldPoll && !shouldPoll(data))) return;
    const handle = window.setInterval(() => setTick((t) => t + 1), pollMs);
    return () => window.clearInterval(handle);
  }, [data, pollMs, shouldPoll]);

  useEffect(() => {
    const revalidate = () => setTick((current) => current + 1);
    window.addEventListener('focus', revalidate);
    window.addEventListener('online', revalidate);
    return () => {
      window.removeEventListener('focus', revalidate);
      window.removeEventListener('online', revalidate);
    };
  }, []);

  const mutate = useCallback((update: (current: T) => T) => {
    if (dataRef.current === null) return;
    const next = update(dataRef.current);
    dataRef.current = next;
    setData(next);
  }, []);

  return { data, loading, error, refresh: () => setTick((t) => t + 1), mutate };
}

function meetingUrl(meetingId: string, suffix = '') {
  const token =
    typeof window !== 'undefined'
      ? window.localStorage.getItem(ANONYMOUS_TOKEN_STORAGE_KEY)
      : null;
  const url = new URL(`/api/meetings/${meetingId}${suffix}`, window.location.origin);
  if (token) url.searchParams.set('anonymousSessionToken', token);
  return url;
}

export interface LiveTranscriptDelta<L> {
  cursor: number;
  ranges: TranscriptRange[];
  lines: L[];
}

interface LiveTranscriptHandlers<L> {
  /** New or replaced lines; apply with `applyTranscriptDelta`. */
  onDelta: (delta: LiveTranscriptDelta<L>) => void;
  /** The meeting's status or notes changed; reload the meeting. */
  onChange: () => void;
}

/**
 * Streams transcript changes for a meeting that is still being recorded or
 * processed, starting from the cursor of the last full read. Returns whether
 * the stream is healthy; when it isn't, the caller should fall back to polling.
 */
export function useLiveTranscript<L>(
  meetingId: string,
  opts: { enabled: boolean; since: number } & LiveTranscriptHandlers<L>,
): boolean {
  const { enabled } = opts;
  // The stream tracks its own position once open, so neither a new cursor nor
  // new handler identities reopen it.
  const latest = useRef(opts);
  latest.current = opts;
  const [healthy, setHealthy] = useState(true);

  useEffect(() => {
    if (!enabled) return;
    if (typeof EventSource === 'undefined') {
      setHealthy(false);
      return;
    }
    const url = meetingUrl(meetingId, '/transcript');
    url.searchParams.set('since', String(latest.current.since));
    const source = new EventSource(url.toString());
    source.onopen = () => setHealthy(true);
    // EventSource retries dropped connections itself; it only gives up (CLOSED)
    // when the server refuses the stream, which is when polling takes over.
    source.onerror = () => setHealthy(source.readyState !== EventSource.CLOSED);
    source.addEventListener('lines', (message) => {
      try {
        latest.current.onDelta(JSON.parse((message as MessageEvent<string>).data) as LiveTranscriptDelta<L>);
      } catch {
        latest.current.onChange();
      }
    });
    const changed = () => latest.current.onChange();
    source.addEventListener('status', changed);
    source.addEventListener('summary', changed);
    source.addEventListener('done', () => {
      source.close();
      changed();
    });
    return () => source.close();
  }, [meetingId, enabled]);

  return enabled ? healthy : true;
}

export interface MeetingListItem {
  id: string;
  title: string;
  description?: string | null;
  startedAt: number;
  durationSec?: number | null;
  status?: string;
}

export const meetingList = createResource('/api/meetings/list', parseMeetingList);

export function useMeetings() {
  return meetingList.use();
}

function parseMeetingList(value: unknown): MeetingListItem[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  return value.items.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.title !== 'string' ||
      typeof item.startedAt !== 'number'
    ) {
      return [];
    }
    return [{
      id: item.id,
      title: item.title,
      description: typeof item.description === 'string' ? item.description : null,
      startedAt: item.startedAt,
      durationSec: typeof item.durationSec === 'number' ? item.durationSec : null,
      status: typeof item.status === 'string' ? item.status : undefined,
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
