'use client';

import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@/lib/next-compat/navigation';
import { errMsg, startAudioCapture, startScreenCapture } from '@/lib/desktop/bridge';
import { loadRecordings } from '@/lib/launcher/data';
import type { Recording } from '@/lib/launcher/types';
import { LauncherToast } from './launcher-toast';
import { PaletteView } from './palette-view';
import type { BeginRecording } from './types';
import { useLauncherCommands } from './use-launcher-commands';
import { useLauncherItems } from './use-launcher-items';
import { useLauncherKeyDown } from './use-launcher-keydown';
import { useRecordingActions } from './use-recording-actions';
import { useToastTasks } from './use-toast-tasks';

/** The web palette's open shortcut; the browser has no global hotkey to read. */
const TOGGLE_HOTKEY = '⌘⇧Space';

/** Shown for the moment between asking to record and the record page loading. */
function StartingView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Starting capture…</p>
      <p className="max-w-xs text-center text-xs text-muted-foreground/70">
        If macOS asks for microphone or screen recording access, allow it and
        this will continue.
      </p>
    </div>
  );
}

/**
 * The command palette at /launcher in a browser: search recordings and
 * commands. Recording itself happens on the web app's record page.
 */
export function WebPalette() {
  const router = useRouter();
  const now = useRef(Date.now()).current;
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionsQuery, setActionsQuery] = useState('');
  const [actionsSel, setActionsSel] = useState(0);
  const [starting, setStarting] = useState(false);
  const startBusy = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const actionsInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { toast, flash, runTask } = useToastTasks();

  useEffect(() => {
    (searchRef.current ?? panelRef.current)?.focus({ preventScroll: true });
    searchRef.current?.select();
    runTask(async () => setRecordings(await loadRecordings(now)), 'Couldn’t load recordings');
  }, [now, runTask]);

  // Outside the Mac app, starting a recording opens the record page.
  const beginRecording = useCallback<BeginRecording>(async (mode, opts) => {
    if (startBusy.current) return;
    startBusy.current = true;
    setStarting(true);
    try {
      if (mode === 'screen') await startScreenCapture(opts?.mic ?? false);
      else await startAudioCapture(opts?.source ?? 'mixed', opts?.contextBlurb, opts?.dictation);
    } catch (e) {
      flash(errMsg(e, 'Couldn’t start recording'), 8000);
    } finally {
      startBusy.current = false;
      setStarting(false);
    }
  }, [flash]);

  const beginMeetingRecording = useCallback(() => {
    void beginRecording('audio', { source: 'mixed' });
  }, [beginRecording]);

  // Pairing is a Mac app thing; the browser is already signed in or not.
  const connectAccount = useCallback(async () => {}, []);

  const goSettings = useCallback(() => {
    runTask(() => router.push('/app/settings'), 'Couldn’t open settings');
  }, [router, runTask]);

  const commands = useLauncherCommands({
    desktop: false,
    router,
    runTask,
    beginRecording,
    beginMeetingRecording,
    connectAccount,
    goSettings,
  });

  const { items, commandCount } = useLauncherItems(commands, recordings, query);

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items.length]);

  const current = items[selected];
  const currentRec = current?.kind === 'recording' ? current.rec : null;

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const openRecording = useCallback(
    (rec: Recording) => {
      if (rec.id.startsWith('demo_')) {
        flash('Demo recording — sign in to open');
        return;
      }
      runTask(() => router.push(`/app/meetings/${rec.id}`), 'Couldn’t open recording');
    },
    [router, flash, runTask],
  );

  const actions = useRecordingActions({
    current,
    currentRec,
    desktop: false,
    flash,
    runTask,
    setActionsOpen,
    openRecording,
  });

  const filteredActions = useMemo(() => {
    const q = actionsQuery.trim();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()));
  }, [actions, actionsQuery]);

  useEffect(() => {
    setActionsSel((s) => Math.min(s, Math.max(0, filteredActions.length - 1)));
  }, [filteredActions.length]);

  const runPrimary = useCallback(() => {
    if (!current) return;
    if (current.kind === 'command') {
      runTask(current.run);
      return;
    }
    openRecording(current.rec);
  }, [current, openRecording, runTask]);

  const openActions = useCallback(() => {
    if (!current) return;
    setActionsQuery('');
    setActionsSel(0);
    setActionsOpen(true);
    requestAnimationFrame(() => actionsInputRef.current?.focus());
  }, [current]);

  const onKeyDown = useLauncherKeyDown({
    actionsOpen,
    setActionsOpen,
    actionsSel,
    setActionsSel,
    setSelected,
    setQuery,
    query,
    items,
    filteredActions,
    currentRec,
    searchRef,
    runPrimary,
    goSettings,
    openActions,
    flash,
    runTask,
  });

  return (
    <div className="launcher-scope fixed inset-0 flex items-center justify-center" data-desktop="false">
      <div className="launcher-scrim absolute inset-0" />
      <div
        data-dragging={false}
        className="launcher-panel ev-panel relative z-10 flex h-[min(460px,92vh)] w-[min(92vw,720px)] flex-col overflow-hidden rounded-2xl border border-border outline-none"
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {starting ? (
          <StartingView />
        ) : (
          <PaletteView
            desktop={false}
            setupPaired={false}
            query={query}
            setQuery={setQuery}
            selected={selected}
            setSelected={setSelected}
            items={items}
            commandCount={commandCount}
            now={now}
            current={current}
            currentRec={currentRec}
            searchRef={searchRef}
            listRef={listRef}
            runPrimary={runPrimary}
            flash={flash}
            runTask={runTask}
            actionsOpen={actionsOpen}
            setActionsOpen={setActionsOpen}
            openActions={openActions}
            actionsQuery={actionsQuery}
            setActionsQuery={setActionsQuery}
            actionsSel={actionsSel}
            setActionsSel={setActionsSel}
            actionsInputRef={actionsInputRef}
            filteredActions={filteredActions}
            onKeyDown={onKeyDown}
            beginMeetingRecording={beginMeetingRecording}
            beginRecording={beginRecording}
            goSettings={goSettings}
            toggleHotkey={TOGGLE_HOTKEY}
          />
        )}
        <LauncherToast toast={toast} />
      </div>
    </div>
  );
}
