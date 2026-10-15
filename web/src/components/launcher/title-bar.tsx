'use client';

import { Settings, X } from 'lucide-react';
import { hidePanel } from '@/lib/desktop/bridge';
import { accountInitial, type AccountState } from '@/components/launcher/settings-view';
import { formatDuration } from '@/lib/utils';
import { type LauncherView, type RunTask } from './types';

export function TitleBar({
  capturePhase,
  elapsed,
  view,
  account,
  connecting,
  recording,
  goSettings,
  runTask,
  stopRecording,
}: {
  capturePhase: string;
  elapsed: number;
  view: LauncherView;
  account: AccountState;
  connecting: boolean;
  recording: boolean;
  goSettings: () => void;
  runTask: RunTask;
  stopRecording: () => Promise<void>;
}) {
  return (
    <div
      data-tauri-drag-region
      className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4"
    >
      <button
        type="button"
        title="Close (esc)"
        aria-label="Close"
        onClick={() => runTask(hidePanel, 'Could not close the launcher')}
        className="grid h-[18px] w-[18px] place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--lr-brand)] hover:text-white"
      >
        <X className="h-3 w-3" strokeWidth={2.5} />
      </button>
      <span data-tauri-drag-region className="select-none text-xs font-semibold text-foreground">
        Eavesy {capturePhase === 'recording' && <span className="ml-2 font-mono font-normal tabular-nums">{formatDuration(elapsed * 1000)}</span>}
      </span>
      {view !== 'settings' && <div className="flex items-center gap-1">
        {account === null && view !== 'setup' && <button type="button" onClick={goSettings} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-[var(--lr-hover)]">{connecting ? 'Connecting…' : 'Sign in'}</button>}
        {account && <button type="button" onClick={goSettings} title={`Signed in${account.email ? ` as ${account.email}` : ''}`} aria-label="Account" className="grid h-6 w-6 place-items-center rounded-full bg-[var(--lr-brand)] text-[11px] font-semibold text-white">{accountInitial(account)}</button>}
        <button type="button" aria-label="Settings" title="Settings (⌘,)" onClick={goSettings} className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-[var(--lr-hover)] hover:text-foreground"><Settings className="h-4 w-4" /></button>
      </div>}
      {view === 'settings' && !recording && <span className="w-[18px]" aria-hidden="true" />}
      {recording && view === 'settings' && <button type="button" onClick={() => runTask(stopRecording)} className="rounded-md bg-[var(--lr-brand)] px-2 py-1 text-xs text-white">Stop &amp; save</button>}

    </div>
  );
}
