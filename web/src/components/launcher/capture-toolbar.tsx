'use client';

import { useEffect, useRef } from 'react';
import { AudioLines, Camera, Clapperboard, Square, Users } from 'lucide-react';
import { clock } from './history-model';
import { talkHint, FN } from './shortcut-keys';
import { Kbd, Mascot, ToolbarSegment, ToolbarShelf } from './ui';
import { useLiveLines } from './use-live-lines';

export type CaptureKind = 'talk' | 'meeting' | 'video';

/** A capture that is starting, running, or being written down. */
export interface LiveCapture {
  /** Null while it is still starting. */
  sessionId: string | null;
  kind: CaptureKind;
  /** `thinking` once stopped, while the words are written down. */
  phase: 'listening' | 'thinking';
  elapsed: number;
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
}) {
  const fn = dictationHotkey === FN || dictationHotkey === 'fn';
  return (
    <div className="ev-toolbar">
      {live ? <LiveBar live={live} stopKey={live.kind === 'talk' ? (fn ? 'fn' : dictationHotkey) : ''} onStop={onStop} /> : <ToolbarShelf>
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

/** Replaces the capture shelf in place, without adding a row above search. */
function LiveBar({ live, stopKey, onStop }: { live: LiveCapture; stopKey: string; onStop: () => void }) {
  const lines = useLiveLines(live.sessionId, 1);
  const thinking = live.phase === 'thinking';
  const started = live.sessionId !== null;
  const text = lines.map((line) => line.text).join(' ');
  const ticker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ticker.current) ticker.current.scrollLeft = ticker.current.scrollWidth;
  }, [text]);
  const label = thinking ? 'Writing it down…' : started ? LIVE_LABEL[live.kind] : 'Starting…';
  return (
    <div className="ev-livebar" data-phase={live.phase}>
      <Mascot size={18} state={thinking ? 'thinking' : started ? 'listening' : 'idle'} recording={!thinking && started} />
      <span className="ev-livebar-label" role="status">{label}</span>
      {started && !thinking && <span className="ev-livebar-time">{clock(live.elapsed)}</span>}
      <span ref={ticker} className="ev-livebar-ticker" title={text}>{text}</span>
      {!thinking && started && (
        <button type="button" className="ev-livebar-stop" onClick={onStop} title={`Stop and save${stopKey ? ` (${stopKey})` : ''}`} aria-label={`Stop and save${stopKey ? ` (${stopKey})` : ''}`}>
          <Square size={10} strokeWidth={0} fill="currentColor" aria-hidden />
          Stop
          {stopKey && <Kbd keys={stopKey} />}
        </button>
      )}
    </div>
  );
}
