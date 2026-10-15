import { useEffect, useState } from 'react';
import { liveTranscript, onLiveCaption, onLiveTranscript } from '@/lib/desktop/bridge';
import { liveView, type LiveCaption, type LiveLine } from '@/lib/desktop/live-captions';
import { cn } from '@/lib/utils';

/**
 * The last few lines of a recording in progress: on-device captions straight
 * away (dimmed while provisional), swapped for cloud lines as they arrive.
 */
export function LiveCaptions({ sessionId }: { sessionId: string }) {
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [partials, setPartials] = useState<Record<string, LiveCaption>>({});

  useEffect(() => {
    let disposed = false;
    const offs: (() => void)[] = [];
    const reload = () => {
      void liveTranscript(sessionId)
        .then((next) => { if (!disposed) setLines(next); })
        .catch(() => {});
    };
    reload();
    void Promise.all([
      onLiveTranscript((id) => { if (id === sessionId) reload(); }),
      onLiveCaption((caption) => {
        if (caption.sessionId === sessionId) setPartials((prev) => ({ ...prev, [caption.track]: caption }));
      }),
    ]).then((listeners) => {
      if (disposed) listeners.forEach((off) => off()); else offs.push(...listeners);
    });
    return () => { disposed = true; offs.forEach((off) => off()); };
  }, [sessionId]);

  const view = liveView(lines, Object.values(partials));
  if (view.length === 0) return null;
  return (
    <section aria-label="Live captions" aria-live="polite" className="mb-3 rounded-lg border border-border px-3 py-2 text-sm leading-snug">
      {view.map((row, index) => (
        <p key={index} className={cn(row.provisional ? 'text-muted-foreground' : 'text-foreground')}>
          {row.label && <span className="mr-1.5 text-[11px] font-medium text-muted-foreground">{row.label}</span>}
          {row.text}
        </p>
      ))}
    </section>
  );
}
