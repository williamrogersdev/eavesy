'use client';

import { AudioLines, Camera, Clapperboard, Users } from 'lucide-react';
import { clock } from './history-model';
import { ToolbarSegment, ToolbarShelf } from './ui';

export type CaptureKind = 'talk' | 'meeting' | 'video';

/**
 * Four equal segments named by purpose (DESIGN.md §5). While a capture runs,
 * its own segment becomes the red Stop with the elapsed time and the others dim.
 */
export function CaptureToolbar({
  active,
  elapsed,
  busy,
  dictationHotkey,
  onTalk,
  onMeeting,
  onScreenshot,
  onVideo,
  onStop,
}: {
  /** The capture running now, if any. */
  active: CaptureKind | null;
  elapsed: number;
  /** A capture is starting or a screenshot is being taken. */
  busy: boolean;
  dictationHotkey: string;
  onTalk: () => void;
  onMeeting: () => void;
  onScreenshot: () => void;
  onVideo: () => void;
  onStop: () => void;
}) {
  const live = active !== null;
  const segment = (kind: CaptureKind, start: () => void) => ({
    active: active === kind,
    dimmed: live && active !== kind,
    disabled: (live && active !== kind) || (busy && !live),
    elapsed: active === kind ? clock(elapsed) : undefined,
    onClick: active === kind ? onStop : start,
  });
  const fn = dictationHotkey === 'Fn' || dictationHotkey === 'fn';
  return (
    <div className="ev-toolbar">
      <ToolbarShelf>
        <ToolbarSegment
          icon={AudioLines}
          label="Talk"
          kbd={fn ? 'fn' : undefined}
          hint={fn ? 'Hold fn to talk. Let go to paste.' : `Talk, then paste where your cursor is${dictationHotkey ? ` (${dictationHotkey})` : ''}`}
          {...segment('talk', onTalk)}
        />
        <ToolbarSegment icon={Users} label="Meeting" hint="Records both sides of a call" {...segment('meeting', onMeeting)} />
        <ToolbarSegment
          icon={Camera}
          label="Screenshot"
          hint="Pick an area to save"
          dimmed={live}
          disabled={live || busy}
          onClick={onScreenshot}
        />
        <ToolbarSegment icon={Clapperboard} label="Video" hint="Record your screen and mic" {...segment('video', onVideo)} />
      </ToolbarShelf>
    </div>
  );
}
