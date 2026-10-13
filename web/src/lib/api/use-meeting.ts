'use client';

import { useEffect, useRef, useState } from 'react';
import { ANONYMOUS_TOKEN_STORAGE_KEY } from '@/lib/runtime';

export interface UseMeetingResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
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

    const token =
      typeof window !== 'undefined'
        ? window.localStorage.getItem(ANONYMOUS_TOKEN_STORAGE_KEY)
        : null;
    const url = new URL(`/api/meetings/${meetingId}`, window.location.origin);
    if (token) url.searchParams.set('anonymousSessionToken', token);

    fetch(url.toString())
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

  return { data, loading, error, refresh: () => setTick((t) => t + 1) };
}

export interface MeetingListItem {
  id: string;
  title: string;
  description?: string | null;
  startedAt: number;
  durationSec?: number | null;
  status?: string;
}

export function useMeetings() {
  const [data, setData] = useState<MeetingListItem[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/meetings/list')
      .then(async (r) => {
        if (!r.ok) throw new Error(`Server returned ${r.status}`);
        const json: unknown = await r.json();
        return json;
      })
      .then((json) => {
        if (!cancelled) setData(parseMeetingList(json));
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
  }, [tick]);

  return { data, loading, error, refresh: () => setTick((t) => t + 1) };
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
