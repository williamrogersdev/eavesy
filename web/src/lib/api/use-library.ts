'use client';

import { useCallback, useMemo, useState } from 'react';
import { type CaptureItem, captureList, useCaptures } from './use-captures';
import { type MeetingListItem, meetingList, parseMeetingList, useMeetings } from './use-meeting';

export function refreshLibrary() {
  void meetingList.refresh();
  void captureList.refresh();
}

export type LibKind = 'meeting' | 'capture';

/** What the item is, in the words people use (DESIGN.md §2). */
export type LibVariant = 'voice' | 'meeting' | 'screenshot' | 'video' | 'screen' | 'audio' | 'image';

export interface LibItem {
  id: string;
  kind: LibKind;
  variant: LibVariant;
  href: string;
  title: string;
  subtitle?: string;
  createdAt: number;
  durationSec?: number | null;
  thumbUrl?: string;
  mediaKind?: CaptureItem['kind'];
  captureMode?: CaptureItem['captureMode'];
  status?: string;
  /** Where it was recorded: the Mac's name, or "Web" / "iPhone"… */
  device?: string;
  /** Call app for meetings, e.g. "Zoom". */
  platform?: string;
}

export interface UseLibraryResult {
  items: LibItem[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  /** True while older recordings may exist beyond what is loaded. */
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
}

const PAGE = 100;

export const CALL_PLATFORMS: Record<string, string> = {
  zoom: 'Zoom',
  meet: 'Google Meet',
  teams: 'Teams',
  phone: 'Phone call',
};

export const SOURCE_LABELS: Record<string, string> = {
  desktop: 'Mac',
  web: 'Web',
  public: 'Web',
  ios: 'iPhone',
  android: 'Android',
  import: 'Import',
  bot: 'Notetaker',
};

function fromMeeting(x: MeetingListItem): LibItem {
  const call = x.platform ? CALL_PLATFORMS[x.platform] : undefined;
  return {
    id: x.id,
    kind: 'meeting',
    variant: call ? 'meeting' : 'voice',
    href: `/app/meetings/${x.id}`,
    title: x.title || 'Untitled recording',
    subtitle: x.description || undefined,
    createdAt: x.startedAt,
    durationSec: x.durationSec,
    status: x.status,
    device: x.deviceName || (x.source ? SOURCE_LABELS[x.source] : undefined),
    platform: call,
  };
}

function fromCapture(x: CaptureItem): LibItem {
  const variant: LibVariant =
    x.captureMode === 'screenshot'
      ? 'screenshot'
      : x.captureMode === 'webcam'
        ? 'video'
        : x.captureMode === 'screen'
          ? 'screen'
          : x.captureMode === 'audio'
            ? 'audio'
            : 'image';
  return {
    id: x.id,
    kind: 'capture',
    variant,
    href: `/app/captures/${x.id}`,
    title: x.title,
    createdAt: x.createdAt,
    durationSec: x.durationSec,
    thumbUrl: x.kind === 'audio' ? undefined : x.url,
    mediaKind: x.kind,
    captureMode: x.captureMode,
  };
}

export function useLibraryItems(): UseLibraryResult {
  const meetings = useMeetings();
  const captures = useCaptures();
  const [older, setOlder] = useState<MeetingListItem[]>([]);
  const [olderDone, setOlderDone] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<Error | null>(null);

  const firstPage = useMemo(() => meetings.data ?? [], [meetings.data]);
  const allMeetings = useMemo(() => {
    const seen = new Set(firstPage.map((m) => m.id));
    return [...firstPage, ...older.filter((m) => !seen.has(m.id))];
  }, [firstPage, older]);

  const items = useMemo<LibItem[]>(
    () =>
      [...allMeetings.map(fromMeeting), ...(captures.data ?? []).map(fromCapture)].sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
    [allMeetings, captures.data],
  );

  const hasOlder = !olderDone && firstPage.length >= PAGE;
  const oldest = allMeetings[allMeetings.length - 1]?.startedAt;

  const loadOlder = useCallback(() => {
    if (loadingOlder || !oldest) return;
    setLoadingOlder(true);
    setOlderError(null);
    const url = new URL('/api/meetings/list', window.location.origin);
    url.searchParams.set('before', String(oldest));
    url.searchParams.set('limit', String(PAGE));
    fetch(url.toString())
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const page = parseMeetingList(await res.json());
        setOlder((current) => [...current, ...page]);
        if (page.length < PAGE) setOlderDone(true);
      })
      .catch((error: unknown) => setOlderError(error instanceof Error ? error : new Error(String(error))))
      .finally(() => setLoadingOlder(false));
  }, [loadingOlder, oldest]);

  return {
    items,
    loading: (meetings.loading && !meetings.data) || (captures.loading && !captures.data),
    error: meetings.error || captures.error || olderError,
    refresh: () => {
      meetings.refresh();
      captures.refresh();
    },
    hasOlder,
    loadingOlder,
    loadOlder,
  };
}
