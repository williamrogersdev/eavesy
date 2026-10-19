'use client';

import { useEffect, useState } from 'react';
import { liveTranscript, onLiveCaption, onLiveTranscript } from '@/lib/desktop/bridge';
import { liveView, type LiveCaption, type LiveLine, type LiveRow } from '@/lib/desktop/live-captions';

/** The newest lines heard in a live capture: cloud lines, then what the Mac is still hearing. */
export function useLiveLines(sessionId: string | null, keep: number): LiveRow[] {
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [partials, setPartials] = useState<Record<string, LiveCaption>>({});
  useEffect(() => {
    setLines([]);
    setPartials({});
    if (!sessionId) return;
    let disposed = false;
    const offs: (() => void)[] = [];
    const reload = () => {
      void liveTranscript(sessionId).then((next) => { if (!disposed) setLines(next); }).catch(() => {});
    };
    reload();
    void Promise.all([
      onLiveTranscript((id) => { if (id === sessionId) reload(); }),
      onLiveCaption((caption) => {
        if (caption.sessionId === sessionId) setPartials((prev) => ({ ...prev, [caption.track]: caption }));
      }),
    ]).then((listeners) => { if (disposed) listeners.forEach((off) => off()); else offs.push(...listeners); });
    return () => { disposed = true; offs.forEach((off) => off()); };
  }, [sessionId]);
  return liveView(lines, Object.values(partials), keep);
}
