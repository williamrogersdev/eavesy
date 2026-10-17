'use client';

import { Loader2, Square } from 'lucide-react';
import { LiveCaptions } from '@/components/launcher/live-captions';
import { formatDuration } from '@/lib/utils';

/**
 * A capture in progress, as a compact row at the top of History. The panel
 * keeps its layout while recording: when the capture stops, the saved item
 * appears in this row's place.
 */
export function InProgressCapture({
  sessionId,
  mode,
  elapsed,
  onStop,
}: {
  /** Null while the capture is still starting. */
  sessionId: string | null;
  mode: 'audio' | 'screen';
  elapsed: number;
  onStop: () => void;
}) {
  return (
    <section aria-label="Recording in progress" className="mb-3 rounded-lg border border-border px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        {sessionId ? (
          <span className="h-2 w-2 shrink-0 animate-recording-pulse rounded-full bg-[var(--lr-brand)]" />
        ) : (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {sessionId ? `Recording ${mode === 'screen' ? 'screen' : 'audio'}` : 'Starting…'}
          {sessionId && <span className="ml-2 font-mono tabular-nums">{formatDuration(elapsed * 1000)}</span>}
        </span>
        {sessionId && (
          <button
            type="button"
            onClick={onStop}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[var(--lr-brand)] hover:bg-[var(--lr-brand-soft)]"
          >
            <Square className="h-3 w-3" fill="currentColor" /> Stop
          </button>
        )}
      </div>
      {sessionId && (
        <div className="mt-2 [&>section]:mb-0 [&>section]:border-0 [&>section]:p-0">
          <LiveCaptions sessionId={sessionId} />
        </div>
      )}
    </section>
  );
}
