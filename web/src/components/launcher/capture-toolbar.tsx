'use client';

import { useEffect, useState } from 'react';
import { AudioLines, Camera, Clapperboard, Square, Users, X } from 'lucide-react';
import { DISCARD_ASKS_AFTER_SEC, DISCARD_CONFIRM_MS } from './discard';
import { clock } from './history-model';
import { talkHint, FN } from './shortcut-keys';
import { ToolbarSegment, ToolbarShelf } from './ui';
import { useLiveLines } from './use-live-lines';

export type CaptureKind = 'talk' | 'meeting' | 'video';

/** A capture that is starting, running, or being written down. */
export interface LiveCapture {
  /** Null while it is still starting. */
  sessionId: string | null;
  kind: CaptureKind;
  /** `thinking` once stopped, while the words are written down. */
  phase: 'listening' | 'thinking';
  /** When it started; the live bar counts from here on its own clock. */
  startedAtMs: number | null;
}

/** Seconds since `startedAtMs`, ticking once a second only inside the live bar. */
function secondsSince(startedAtMs: number | null): number {
  return startedAtMs === null ? 0 : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
}

/** Seconds since `startedAtMs`, ticking once a second only inside the live bar. */
function useElapsed(startedAtMs: number | null): number {
  const [elapsed, setElapsed] = useState(() => secondsSince(startedAtMs));
  useEffect(() => {
    setElapsed(secondsSince(startedAtMs));
    if (startedAtMs === null) return;
    const timer = window.setInterval(() => setElapsed(secondsSince(startedAtMs)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAtMs]);
  return elapsed;
}

/**
 * Four equal segments named by purpose (DESIGN.md §5). While a capture runs,
 * the whole shelf becomes the live bar: the one place the panel says it is
 * recording, with the newest words, the time, and Stop.
 */
export function CaptureToolbar({
  live,
  busy,
  dictationHotkey,
  onTalk,
  onMeeting,
  onScreenshot,
  onVideo,
  onStop,
  onCancel,
}: {
  /** The capture running now, if any. */
  live: LiveCapture | null;
  /** A capture is starting or a screenshot is being taken. */
  busy: boolean;
  dictationHotkey: string;
  onTalk: () => void;
  onMeeting: () => void;
  onScreenshot: () => void;
  onVideo: () => void;
  onStop: () => void;
  /** Ends the capture without saving it. */
  onCancel: () => void;
}) {
  const fn = dictationHotkey === FN || dictationHotkey === 'fn';
  return (
    <div className="ev-toolbar">
      {live ? <LiveBar live={live} stopKey={live.kind === 'talk' ? (fn ? 'fn' : dictationHotkey) : ''} onStop={onStop} onCancel={onCancel} /> : <ToolbarShelf>
        <ToolbarSegment
          icon={AudioLines}
          label="Talk"
          kbd={fn ? 'fn' : undefined}
          hint={talkHint(fn ? FN : dictationHotkey)}
          disabled={busy || !!live}
          onClick={onTalk}
        />
        <ToolbarSegment icon={Users} label="Meeting" hint="Records both sides of a call" disabled={busy || !!live} onClick={onMeeting} />
        <ToolbarSegment icon={Camera} label="Screenshot" hint="Pick an area to save" disabled={busy || !!live} onClick={onScreenshot} />
        <ToolbarSegment icon={Clapperboard} label="Video" hint="Record your screen and mic" disabled={busy || !!live} onClick={onVideo} />
      </ToolbarShelf>}
    </div>
  );
}

const LIVE_LABEL: Record<CaptureKind, string> = { talk: 'Listening', meeting: 'Meeting', video: 'Recording screen' };

/** Lines the live card keeps, the same count the pill shows, so nothing you were reading moves. */
export const LIVE_CARD_LINES = 4;

/**
 * The pill, carried into the panel: the same charcoal card, coral light and
 * newest lines, in place of the capture shelf. The title bar's mascot is the
 * only mascot while it runs.
 */
function LiveBar({ live, stopKey, onStop, onCancel }: { live: LiveCapture; stopKey: string; onStop: () => void; onCancel: () => void }) {
  const lines = useLiveLines(live.sessionId, LIVE_CARD_LINES);
  const elapsed = useElapsed(live.sessionId !== null ? live.startedAtMs : null);
  // Past a short note, Cancel asks first: the × turns into Discard for a moment.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), DISCARD_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  const cancel = () => {
    if (elapsed >= DISCARD_ASKS_AFTER_SEC && !confirming) { setConfirming(true); return; }
    setConfirming(false);
    onCancel();
  };
  const thinking = live.phase === 'thinking';
  const started = live.sessionId !== null;
  const label = thinking ? 'Writing it down…' : started ? LIVE_LABEL[live.kind] : 'Starting…';
  const stopTitle = `Stop and save${stopKey ? ` (${stopKey})` : ''}`;
  return (
    <div className="ev-livebar" data-phase={live.phase}>
      <div className="ev-livebar-head">
        {!thinking && started && <span className="ev-livebar-dot" aria-hidden />}
        <span className="ev-livebar-label" role="status">{label}</span>
        {started && !thinking && <span className="ev-livebar-time">{clock(elapsed)}</span>}
        <span className="ev-livebar-spacer" />
        {!thinking && started && (confirming
          ? <button type="button" className="ev-livebar-discard" onClick={cancel} title="Click again to throw this recording away">Discard</button>
          : <button type="button" className="ev-livebar-cancel" onClick={cancel} title="Cancel: throw this recording away without saving" aria-label="Cancel recording">
            <X size={14} aria-hidden />
          </button>
        )}
        {!thinking && started && (
          <button type="button" className="ev-livebar-stop" onClick={onStop} title={stopTitle} aria-label={stopTitle}>
            <Square size={9} strokeWidth={0} fill="currentColor" aria-hidden />
            Stop
          </button>
        )}
      </div>
      {lines.length > 0 && (
        <div className="ev-livebar-lines" aria-live="off">
          {lines.map((line, i) => (
            <p key={i} data-latest={i === lines.length - 1 || undefined}>{line.text}</p>
          ))}
        </div>
      )}
    </div>
  );
}
