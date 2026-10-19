'use client';

import { useState } from 'react';
import { AudioLines, Camera, ChevronDown, Clapperboard, Square, Users } from 'lucide-react';
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
  if (live) return <div className="ev-toolbar"><LiveBar live={live} stopKey={live.kind === 'talk' ? (fn ? 'fn' : dictationHotkey) : ''} onStop={onStop} /></div>;
  return (
    <div className="ev-toolbar">
      <ToolbarShelf>
        <ToolbarSegment
          icon={AudioLines}
          label="Talk"
          kbd={fn ? 'fn' : undefined}
          hint={talkHint(fn ? FN : dictationHotkey)}
          disabled={busy}
          onClick={onTalk}
        />
        <ToolbarSegment icon={Users} label="Meeting" hint="Records both sides of a call" disabled={busy} onClick={onMeeting} />
        <ToolbarSegment icon={Camera} label="Screenshot" hint="Pick an area to save" disabled={busy} onClick={onScreenshot} />
        <ToolbarSegment icon={Clapperboard} label="Video" hint="Record your screen and mic" disabled={busy} onClick={onVideo} />
      </ToolbarShelf>
    </div>
  );
}

const LIVE_LABEL: Record<CaptureKind, string> = { talk: 'Listening', meeting: 'Meeting', video: 'Recording screen' };

/** The shelf while a capture runs. Click it to see more of what has been heard. */
function LiveBar({ live, stopKey, onStop }: { live: LiveCapture; stopKey: string; onStop: () => void }) {
  const [open, setOpen] = useState(false);
  const lines = useLiveLines(live.sessionId, 4);
  const thinking = live.phase === 'thinking';
  const started = live.sessionId !== null;
  const last = lines.at(-1)?.text ?? '';
  const label = thinking ? 'Writing it down…' : started ? LIVE_LABEL[live.kind] : 'Starting…';
  return (
    <div className="ev-livebar" data-phase={live.phase} data-open={open || undefined}>
      <div className="ev-livebar-row">
        <button
          type="button"
          className="ev-livebar-main"
          aria-expanded={open}
          aria-label={`${label}${started && !thinking ? `, ${clock(live.elapsed)}` : ''}. ${open ? 'Hide' : 'Show'} what has been heard`}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="ev-livebar-mark" aria-hidden>
            <Mascot size={16} state={thinking ? 'thinking' : started ? 'listening' : 'idle'} recording={!thinking && started} />
          </span>
          <span className="ev-livebar-label" aria-live="polite">{label}</span>
          {started && !thinking && <span className="ev-livebar-time">{clock(live.elapsed)}</span>}
          <span className="ev-livebar-words"><bdi>{open ? '' : last}</bdi></span>
          <ChevronDown size={14} strokeWidth={1.75} className="ev-livebar-chev" aria-hidden />
        </button>
        {!thinking && started && (
          <button type="button" className="ev-livebar-stop" onClick={onStop} title={`Stop and save${stopKey ? ` (${stopKey})` : ''}`} aria-label={`Stop and save${stopKey ? ` (${stopKey})` : ''}`}>
            <Square size={10} strokeWidth={0} fill="currentColor" aria-hidden />
            Stop
            {stopKey && <Kbd keys={stopKey} />}
          </button>
        )}
      </div>
      <div className="ev-livebar-more" aria-hidden={!open}>
        <div>
          {lines.length > 0 ? (
            lines.map((line, i) => (
              <p key={i} data-provisional={line.provisional || undefined}>
                {line.label && <b>{line.label} </b>}{line.text}
              </p>
            ))
          ) : (
            <p className="ev-livebar-empty">{thinking ? 'Almost there…' : started ? 'Say something. Your words show up here as you talk.' : 'Opening the mic…'}</p>
          )}
        </div>
      </div>
    </div>
  );
}
