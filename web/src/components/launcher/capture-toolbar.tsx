'use client';

import { Camera, Mic, Square, Video, Volume2, VolumeX } from 'lucide-react';
import { type MutableRefObject } from 'react';
import { captureScreenshot } from '@/lib/desktop/bridge';
import { setIncludeComputerAudio } from '@/lib/desktop/capture-prefs';
import { cn } from '@/lib/utils';
import { type BeginRecording, type RunTask } from './types';

export function CaptureToolbar({
  recording,
  withComputerAudio,
  starting,
  dictationHotkey,
  captureBusy,
  setStarting,
  runTask,
  stopRecording,
  beginRecording,
}: {
  recording: boolean;
  withComputerAudio: boolean;
  starting: boolean;
  dictationHotkey: string;
  captureBusy: MutableRefObject<boolean>;
  setStarting: (starting: boolean) => void;
  runTask: RunTask;
  stopRecording: () => Promise<void>;
  beginRecording: BeginRecording;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-around border-b border-border px-2 text-[11px] text-muted-foreground">
      <span className="flex items-center">
        <button type="button" aria-label={recording ? 'Stop & save' : withComputerAudio ? 'Record mic and computer audio' : 'Start voice note'} disabled={starting} title={dictationHotkey ? `${recording ? 'Stop & save' : 'Start recording'} from anywhere with ${dictationHotkey}` : undefined} onClick={() => recording ? runTask(stopRecording) : runTask(() => beginRecording('audio', { source: withComputerAudio ? 'mixed' : 'mic' }))} className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[var(--lr-brand)] hover:bg-[var(--lr-brand-soft)]">{recording ? <Square className="h-3.5 w-3.5" fill="currentColor" /> : <Mic className="h-3.5 w-3.5" />} {recording ? 'Stop' : 'Microphone'}{dictationHotkey && <kbd className="ml-0.5 font-sans text-[10px] tracking-wide text-muted-foreground/70">{dictationHotkey}</kbd>}</button>
        {!recording && <button type="button" aria-pressed={withComputerAudio} onClick={() => setIncludeComputerAudio(!withComputerAudio)} title={withComputerAudio ? 'Recording computer audio too (calls and meetings). Click to record only your mic.' : 'Also record computer audio, for calls and meetings'} aria-label="Include computer audio" className={cn('grid h-6 w-6 place-items-center rounded-full', withComputerAudio ? 'bg-[var(--lr-brand-soft)] text-[var(--lr-brand)]' : 'text-muted-foreground hover:bg-[var(--lr-hover)]')}>{withComputerAudio ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}</button>}
      </span>
      <button type="button" aria-label="Take screenshot" disabled={starting || !!recording} onClick={() => runTask(async () => { if (captureBusy.current) return; captureBusy.current = true; setStarting(true); try { await captureScreenshot(); } finally { captureBusy.current = false; setStarting(false); } })} className="flex items-center gap-1.5 rounded-full px-2 py-1 hover:bg-[var(--lr-hover)] disabled:opacity-40"><Camera className="h-3.5 w-3.5" /> Screenshot</button>
      <button type="button" aria-label="Record screen video" disabled={starting || !!recording} onClick={() => runTask(() => beginRecording('screen', { mic: true }))} className="flex items-center gap-1.5 rounded-full px-2 py-1 hover:bg-[var(--lr-hover)] disabled:opacity-40"><Video className="h-3.5 w-3.5" /> Video</button>
    </div>
  );
}
