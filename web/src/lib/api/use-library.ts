'use client';

import { useCallback, useMemo, useState } from 'react';
import { type CaptureItem, captureList, parseCaptureList, useCaptures } from './use-captures';
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
  const [olderMeetings, setOlderMeetings] = useState<MeetingListItem[]>([]);
  const [olderCaptures, setOlderCaptures] = useState<CaptureItem[]>([]);
  const [meetingsDone, setMeetingsDone] = useState(false);
  const [capturesDone, setCapturesDone] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<Error | null>(null);

  const firstMeetings = useMemo(() => meetings.data ?? [], [meetings.data]);
  const firstCaptures = useMemo(() => captures.data ?? [], [captures.data]);
  const allMeetings = useMemo(() => mergeById(firstMeetings, olderMeetings), [firstMeetings, olderMeetings]);
  const allCaptures = useMemo(() => mergeById(firstCaptures, olderCaptures), [firstCaptures, olderCaptures]);

  const items = useMemo<LibItem[]>(
    () => [...allMeetings.map(fromMeeting), ...allCaptures.map(fromCapture)].sort((a, b) => b.createdAt - a.createdAt),
    [allMeetings, allCaptures],
  );

  // Each list pages on its own cursor; a full first page means there may be more.
  const meetingsMore = !meetingsDone && firstMeetings.length >= PAGE;
  const capturesMore = !capturesDone && firstCaptures.length >= PAGE;
  const hasOlder = meetingsMore || capturesMore;
  const oldestMeeting = allMeetings[allMeetings.length - 1]?.startedAt;
  const oldestCapture = allCaptures[allCaptures.length - 1]?.createdAt;

  const loadOlder = useCallback(() => {
    if (loadingOlder) return;
    const pageUrl = (path: string, before: number) => {
      const url = new URL(path, window.location.origin);
      url.searchParams.set('before', String(before));
      url.searchParams.set('limit', String(PAGE));
      return url.toString();
    };
    const fetchPage = async (path: string, before: number): Promise<unknown> => {
      const res = await fetch(pageUrl(path, before));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    const jobs: Promise<void>[] = [];
    if (meetingsMore && oldestMeeting) {
      jobs.push(fetchPage('/api/meetings/list', oldestMeeting).then((json) => {
        const page = parseMeetingList(json);
        setOlderMeetings((current) => [...current, ...page]);
        if (page.length < PAGE) setMeetingsDone(true);
      }));
    }
    if (capturesMore && oldestCapture) {
      jobs.push(fetchPage('/api/captures', oldestCapture).then((json) => {
        const page = parseCaptureList(json);
        setOlderCaptures((current) => [...current, ...page]);
        if (page.length < PAGE) setCapturesDone(true);
      }));
    }
    if (!jobs.length) return;
    setLoadingOlder(true);
    setOlderError(null);
    Promise.all(jobs)
      .catch((error: unknown) => setOlderError(error instanceof Error ? error : new Error(String(error))))
      .finally(() => setLoadingOlder(false));
  }, [loadingOlder, meetingsMore, capturesMore, oldestMeeting, oldestCapture]);

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

function mergeById<T extends { id: string }>(first: T[], older: T[]): T[] {
  const seen = new Set(first.map((item) => item.id));
  return [...first, ...older.filter((item) => !seen.has(item.id))];
}
