'use client';

import { useMemo } from 'react';
import { type CaptureItem, captureList, useCaptures } from './use-captures';
import { type MeetingListItem, meetingList, useMeetings } from './use-meeting';

export function refreshLibrary() {
  void meetingList.refresh();
  void captureList.refresh();
}

export type LibKind = 'meeting' | 'capture';

export interface LibItem {
  id: string;
  kind: LibKind;
  href: string;
  title: string;
  subtitle?: string;
  createdAt: number;
  durationSec?: number | null;
  thumbUrl?: string;
  mediaKind?: CaptureItem['kind'];
  captureMode?: CaptureItem['captureMode'];
  status?: string;
}

export interface UseLibraryResult {
  items: LibItem[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

export function useLibraryItems(): UseLibraryResult {
  const meetings = useMeetings();
  const captures = useCaptures();

  const items = useMemo<LibItem[]>(() => {
    const m: LibItem[] = (meetings.data ?? []).map((x: MeetingListItem) => ({
      id: x.id,
      kind: 'meeting',
      href: `/app/meetings/${x.id}`,
      title: x.title || 'Untitled recording',
      subtitle: x.description || undefined,
      createdAt: x.startedAt,
      durationSec: x.durationSec,
      status: x.status,
    }));
    const c: LibItem[] = (captures.data ?? []).map((x) => ({
      id: x.id,
      kind: 'capture',
      href: `/app/captures/${x.id}`,
      title: x.title,
      createdAt: x.createdAt,
      durationSec: x.durationSec,
      thumbUrl: x.kind === 'audio' ? undefined : x.url,
      mediaKind: x.kind,
      captureMode: x.captureMode,
    }));
    return [...m, ...c].sort((a, b) => b.createdAt - a.createdAt);
  }, [meetings.data, captures.data]);

  return {
    items,
    loading: (meetings.loading && !meetings.data) || (captures.loading && !captures.data),
    error: meetings.error || captures.error,
    refresh: () => {
      meetings.refresh();
      captures.refresh();
    },
  };
}
