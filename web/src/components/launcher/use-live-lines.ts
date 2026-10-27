'use client';

import { useEffect, useMemo, useState } from 'react';
import { liveTranscript, onLiveCaption, onLiveTranscript } from '@/lib/desktop/bridge';
import { addCaption, EMPTY_RUNNING, liveView, type RunningTranscript, type LiveLine, type LiveRow } from '@/lib/desktop/live-captions';

/** The newest lines heard in a live capture: cloud lines, then what the Mac is still hearing. */
export function useLiveLines(sessionId: string | null, keep: number): LiveRow[] {
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [running, setRunning] = useState<RunningTranscript>(EMPTY_RUNNING);
  useEffect(() => {
    setLines([]);
    setRunning(EMPTY_RUNNING);
    if (!sessionId) return;
    let disposed = false;
    const offs: (() => void)[] = [];
    let revision = 0;
    const reload = () => {
      const request = ++revision;
      void liveTranscript(sessionId).then((next) => { if (!disposed && request === revision) setLines(next); }).catch(() => {});
    };
    void Promise.all([
      onLiveTranscript((id) => { if (id === sessionId) reload(); }),
      onLiveCaption((caption) => {
        if (!disposed && caption.sessionId === sessionId) setRunning((prev) => addCaption(prev, caption));
      }),
    ]).then((listeners) => { if (disposed) listeners.forEach((off) => off()); else { offs.push(...listeners); reload(); } });
    return () => { disposed = true; offs.forEach((off) => off()); };
  }, [sessionId]);
  return useMemo(() => liveView(lines, [...running.finals, ...Object.values(running.partials)], keep), [lines, running, keep]);
}
