'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  completeSetup,
  errMsg,
  getSettings,
  getSetupStatus,
  hidePanel,
  importFiles,
  onAssistantShow,
  onDictionaryLearning,
  onDragDrop,
  onLauncherOpened,
  onLauncherRecordings,
  onLauncherSetup,
  onRecordingsUpdated,
  openSettingsWindow,
  pasteToComposer,
  pickAndImportFiles,
  relaunchApp,
  saveNote,
  setPanelPinned,
  type ImportResult,
  type PrivacyPane,
} from '@/lib/desktop/bridge';
import { learnedLabel } from '@/lib/desktop/learning';
import { prettyAccel } from '@/lib/launcher/accel';
import { CaptureHistory, focusSearch, focusSearchQuietly } from './capture-history';
import { CaptureToolbar } from './capture-toolbar';
import { EavesyTab } from './eavesy-tab';
import { LauncherToast } from './launcher-toast';
import { usesFnKey } from './permission-checklist';
import { ResizeHandles } from './resize-handles';
import { SetupView } from './setup-view';
import { TitleBar } from './title-bar';
import { ProjectChip } from './project-chip';
import { Composer, type ComposerHandle } from './ui';
import { useAccount } from './use-account';
import { useCaptureSession } from './use-capture-session';
import { useProject } from './use-project';
import { useSavedPrompts } from './use-saved-prompts';
import { useSetupPermissions } from './use-setup-permissions';
import { useSignedOut } from './use-signed-out';
import { useToastTasks } from './use-toast-tasks';

type PanelView = 'setup' | 'list';
type PanelTab = 'eavesy' | 'captures';
const PANEL_TABS: [PanelTab, string][] = [['eavesy', 'Eavesy'], ['captures', 'Captures']];
const TAB_KEY = 'eavesy.panel.tab';

/** A key press meant for a field (or a pop-up list), which the panel's shortcuts leave alone. */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

/**
 * The macOS capture panel (DESIGN.md §5–6): title bar, capture toolbar, history
 * and composer, or the first-run setup. Settings live in their own window.
 */
export function DesktopPanel() {
  const [view, setView] = useState<PanelView>('setup');
  // The Eavesy tab comes first (assistant.md); the last one you picked is remembered.
  const [tab, setTab] = useState<PanelTab>(() => {
    try { return localStorage.getItem(TAB_KEY) === 'eavesy' ? 'eavesy' : 'captures'; }
    catch { return 'captures'; }
  });
  const pickTab = useCallback((next: PanelTab) => {
    setTab(next);
    try { localStorage.setItem(TAB_KEY, next); } catch { /* remembered for this session only */ }
  }, []);
  useEffect(() => {
    const off = onAssistantShow(() => pickTab('eavesy'));
    return () => { void off.then((stop) => stop()); };
  }, [pickTab]);
  const [setupKnown, setSetupKnown] = useState(false);
  const setupForced = useRef(false);
  const [setupStep, setSetupStep] = useState(0);
  const [setupPaired, setSetupPaired] = useState(false);
  // Bumped each time the panel opens, so prompts edited elsewhere show up and search starts fresh.
  const [opened, setOpened] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [toggleHotkey, setToggleHotkey] = useState('⌘⇧Space');
  const [dictationHotkey, setDictationHotkey] = useState('');
  const composerRef = useRef<ComposerHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Search sits in the tab row, but its state belongs to the history it filters.
  const [searchSlot, setSearchSlot] = useState<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  // Before the history has loaded there is no search yet, so the panel itself takes focus.
  const focusPanel = useCallback(() => {
    if (searchRef.current) focusSearchQuietly(searchRef.current);
    else panelRef.current?.focus({ preventScroll: true });
    searchRef.current?.select();
  }, []);

  const { toast, flash, runTask } = useToastTasks();
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void onDictionaryLearning(event => {
      const learned = learnedLabel(event);
      if (learned) flash(`${learned} to your dictionary`);
      else if (event.status === 'failed' && event.message) flash(event.message, 5000, 'warn');
    }).then(stop => { if (cancelled) stop(); else dispose = stop; });
    return () => { cancelled = true; dispose?.(); };
  }, [flash]);

  const refreshSetup = useCallback(async (chooseView = false) => {
    try {
      const status = await getSetupStatus();
      if (status) setSetupPaired(status.paired);
      if (chooseView) {
        setView((current) =>
          current === 'setup' && setupForced.current
            ? current
            : status && !status.completed
              ? 'setup'
              : 'list',
        );
      }
    } finally {
      setSetupKnown(true);
    }
  }, []);

  const { account, connecting, connect, cancelConnect, disconnect, refresh: refreshAccount } = useAccount({
    flash,
    runTask,
    afterSignIn: () => refreshSetup(true),
  });
  useEffect(() => {
    if (account !== undefined) setSetupPaired(account !== null);
  }, [account]);
  const savedPrompts = useSavedPrompts(!!account, opened);
  const project = useProject(!!account);
  const projectIdRef = useRef<string | undefined>(undefined);
  projectIdRef.current = project.active?.id;
  const signedOut = useSignedOut(true, runTask);

  const fnInUse = usesFnKey(dictationHotkey, toggleHotkey);
  const {
    setupPermissions,
    setSetupPermissions,
    checkingSetupPermissions,
    requestSetupPermission,
    openPrivacy,
  } = useSetupPermissions({ desktop: true, poll: view === 'setup', fnInUse, flash, runTask });

  const bumpHistory = useCallback(() => setHistoryRevision((revision) => revision + 1), []);
  const capture = useCaptureSession({
    flash,
    runTask,
    projectIdRef,
    permissions: setupPermissions,
    setPermissions: setSetupPermissions,
    onStopped: bumpHistory,
  });
  const { live, recording, notice, clearNotice } = capture;

  // A quiet, lasting note on the list while something dictation relies on is off.
  const permissionNudge: { text: string; pane: PrivacyPane } | null = !setupPermissions
    ? null
    : setupPermissions.accessibility === false
      ? { text: 'Dictation is copied, not pasted: Accessibility is off for Eavesy.', pane: 'accessibility' }
      : setupPermissions.inputMonitoring === false && fnInUse
        ? { text: 'fn can’t start dictation: Input Monitoring is off for Eavesy.', pane: 'input_monitoring' }
        : null;

  /** Something landed in the history from the composer: show it and say so quietly. */
  const landed = useCallback((result?: ImportResult | null) => {
    if (result && result.skipped.length) flash(result.skipped.join(' '), 5000, 'warn');
    if (!result || result.ids.length) {
      historyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      composerRef.current?.confirm();
    }
  }, [flash]);

  /** ⌘V outside a text field: files and images save at once, text becomes a draft. */
  const pasteFromClipboard = useCallback(() => {
    runTask(async () => {
      const outcome = await pasteToComposer();
      if (outcome.kind === 'text') composerRef.current?.insertText(outcome.text);
      else landed({ ids: Array.from({ length: outcome.count }, () => ''), skipped: outcome.skipped });
    }, 'Couldn’t paste that');
  }, [landed, runTask]);

  const keepPinned = view === 'setup' || checkingSetupPermissions !== null || capture.preflighting;
  useEffect(() => {
    runTask(() => setPanelPinned(keepPinned), 'Couldn’t keep the panel open');
  }, [keepPinned, runTask]);

  // The tray's "Recordings" and "Set up" items.
  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    runTask(async () => {
      const listeners = await Promise.all([
        onLauncherRecordings(() => { setView((v) => (v === 'setup' ? v : 'list')); historyRef.current?.scrollTo({ top: 0 }); }),
        onLauncherSetup(() => { setupForced.current = true; setSetupStep(0); setView('setup'); }),
      ]);
      if (disposed) listeners.forEach((off) => off()); else unlisteners.push(...listeners);
    });
    return () => { disposed = true; unlisteners.forEach((off) => off()); };
  }, [runTask]);

  useEffect(() => {
    runTask(async () => {
      const settings = await getSettings();
      if (settings?.toggle_hotkey) setToggleHotkey(prettyAccel(settings.toggle_hotkey));
      if (settings?.dictation_hotkey) setDictationHotkey(prettyAccel(settings.dictation_hotkey));
    }, 'Couldn’t load desktop settings');
    runTask(() => refreshSetup(true), 'Couldn’t load setup status');
  }, [refreshSetup, runTask]);

  // Every native "recordings changed" event; the history debounces and batches them.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    runTask(async () => {
      const stopListening = await onRecordingsUpdated(bumpHistory);
      if (disposed) stopListening();
      else unlisten = stopListening;
    }, 'Couldn’t watch recording updates');
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [bumpHistory, runTask]);

  // Native drag-drop (real file paths): the composer becomes the drop target.
  // Subscribed once; the handler reads the latest callbacks through a ref.
  const onDrop = useRef<(paths: string[]) => void>(() => {});
  useEffect(() => {
    onDrop.current = (paths) => runTask(async () => landed(await importFiles(paths)), 'Couldn’t add those files');
  }, [landed, runTask]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onDragDrop((event) => {
      if (event.type === 'enter' || event.type === 'over') setDragging(true);
      else if (event.type === 'leave') setDragging(false);
      else {
        setDragging(false);
        setView('list');
        onDrop.current(event.paths);
      }
    })
      .then((off) => { if (disposed) off(); else unlisten = off; })
      .catch((error: unknown) => flash(errMsg(error, 'Couldn’t listen for dropped files'), 5000, 'warn'));
    return () => { disposed = true; unlisten?.(); };
  }, [flash]);

  useEffect(() => {
    focusPanel();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    runTask(async () => {
      const stopListening = await onLauncherOpened(() => {
        setupForced.current = false;
        setView((v) => (v === 'setup' ? v : 'list'));
        historyRef.current?.scrollTo({ top: 0 });
        setOpened((n) => n + 1);
        clearNotice();
        runTask(() => refreshSetup(true), 'Couldn’t refresh setup status');
        runTask(refreshAccount);
        requestAnimationFrame(focusPanel);
      });
      if (disposed) stopListening();
      else unlisten = stopListening;
    }, 'Couldn’t register the launcher shortcut');
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [clearNotice, focusPanel, refreshSetup, refreshAccount, runTask]);

  const goSettings = useCallback(() => {
    runTask(() => openSettingsWindow(), 'Couldn’t open settings');
  }, [runTask]);
  const manageProjects = useCallback(() => {
    runTask(() => openSettingsWindow('projects'), 'Couldn’t open settings');
  }, [runTask]);

  // Document-level keys for the history view, so they work wherever focus is
  // (the panel div only gets keys while it has focus): ⌘V pastes, / searches,
  // N writes a note, Esc closes.
  useEffect(() => {
    if (view !== 'list') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      // A menu handles its own keys, even when focus has left it for the body.
      const inMenu = !!target?.closest('[role="menu"]') || !!document.querySelector('[role="menu"][data-state="open"]');
      if (inMenu || document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (isTyping(target)) {
        if (e.key === 'Escape' && target === searchRef.current && !searchRef.current?.value) {
          e.preventDefault();
          runTask(hidePanel, 'Couldn’t close the panel');
        }
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === ',') {
        e.preventDefault();
        goSettings();
      } else if (meta && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        pasteFromClipboard();
      } else if (!meta && !e.altKey && e.key === '/') {
        e.preventDefault();
        if (searchRef.current) focusSearch(searchRef.current);
      } else if (!meta && !e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        composerRef.current?.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        runTask(hidePanel, 'Couldn’t close the panel');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view, pasteFromClipboard, goSettings, runTask]);

  // Keys while focus is in the panel itself: ⌘, opens Settings, and Esc closes setup.
  const onPanelKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); goSettings(); return; }
    if (view === 'setup' && e.key === 'Escape') {
      e.preventDefault();
      runTask(hidePanel, 'Couldn’t close the panel');
    }
  }, [goSettings, runTask, view]);

  const reloadShortcuts = useCallback(() => runTask(async () => {
    const saved = await getSettings();
    if (saved) {
      setToggleHotkey(prettyAccel(saved.toggle_hotkey));
      setDictationHotkey(prettyAccel(saved.dictation_hotkey));
    }
  }), [runTask]);

  /** Resolves with whether setup was saved as finished; a failure is shown here. */
  const finishSetup = useCallback(async (): Promise<boolean> => {
    try {
      await completeSetup();
      setupForced.current = false;
      setView('list');
      searchRef.current?.focus();
      return true;
    } catch (error) {
      flash(errMsg(error, 'Couldn’t finish setup'));
      return false;
    }
  }, [flash]);

  const runNotice = useCallback(() => {
    if (!notice) return;
    if (notice.pane) { openPrivacy(notice.pane); return; }
    clearNotice();
    notice.retry?.();
  }, [clearNotice, notice, openPrivacy]);

  return (
    <div className="launcher-scope fixed inset-0 flex items-stretch justify-stretch" data-desktop="true">
      <div
        data-dragging={dragging}
        className="launcher-panel ev-panel relative z-10 flex h-full w-full flex-col overflow-hidden rounded-[12px] border border-border outline-none"
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        <ResizeHandles />
        <TitleBar
          setup={view === 'setup'}
          account={account}
          connecting={connecting}
          signedOut={signedOut}
          goSettings={goSettings}
          connect={connect}
          disconnect={disconnect}
          runTask={runTask}
          mascot={!live ? 'idle' : live.phase === 'thinking' ? 'thinking' : live.sessionId !== null ? 'listening' : 'idle'}
        />
        {view === 'list' && (
          <div className="ev-tabs">
            <div className="ev-tabs-list" role="tablist" aria-label="Panel">
              {PANEL_TABS.map(([value, label]) => (
                <button key={value} type="button" role="tab" className="ev-tab" aria-selected={tab === value} onClick={() => pickTab(value)}>
                  {label}
                </button>
              ))}
            </div>
            {tab === 'captures' && (
              <div className="ev-tabs-end">
                {account && project && <ProjectChip choice={project} runTask={runTask} onManage={manageProjects} />}
                <div ref={setSearchSlot} className="ev-search-slot" />
              </div>
            )}
          </div>
        )}
        {view === 'list' && tab === 'captures' && (
          <CaptureToolbar
            live={live}
            busy={capture.starting || capture.shooting}
            dictationHotkey={dictationHotkey}
            onTalk={() => runTask(() => capture.begin('audio', { source: 'mic', dictation: true }))}
            onMeeting={() => runTask(() => capture.begin('audio', { source: 'mixed' }))}
            onVideo={() => runTask(() => capture.begin('screen', { mic: true }))}
            onScreenshot={capture.screenshot}
            onStop={() => runTask(capture.stop, 'Couldn’t stop the recording')}
            onCancel={() => runTask(capture.cancel, 'Couldn’t cancel the recording')}
          />
        )}
        {view === 'list' && notice && (
          <div role="alert" className="ev-banner">
            <span>{notice.text}</span>
            <button type="button" className="ev-link" onClick={runNotice}>{notice.action}</button>
          </div>
        )}
        {view === 'list' && signedOut && account !== null && (
          <div role="alert" className="ev-banner">
            <span>Sync is paused. Captures stay on this Mac until you sign in again.</span>
            <button type="button" className="ev-link" disabled={connecting} onClick={connect}>Sign in</button>
          </div>
        )}
        {view === 'list' && permissionNudge && (
          <div role="status" className="ev-banner" data-tone="quiet">
            <span>{permissionNudge.text}</span>
            <button type="button" className="ev-link" onClick={() => openPrivacy(permissionNudge.pane)}>Open Settings</button>
          </div>
        )}
        {!setupKnown ? (
          <div className="min-h-0 flex-1" aria-busy="true" />
        ) : view === 'setup' ? (
          <SetupView
            step={setupStep}
            onStep={setSetupStep}
            paired={setupPaired}
            connecting={connecting}
            account={account}
            permissions={setupPermissions}
            checking={checkingSetupPermissions}
            listening={!!recording && capture.phase !== 'transcribing'}
            liveSessionId={recording?.session.session_id ?? null}
            dictationHotkey={dictationHotkey}
            toggleHotkey={toggleHotkey}
            onConnect={connect}
            onCancelConnect={cancelConnect}
            onRequest={requestSetupPermission}
            onOpenPrivacy={openPrivacy}
            onRelaunch={() => runTask(relaunchApp, 'Couldn’t reopen Eavesy')}
            onShortcutsChanged={reloadShortcuts}
            onFinish={() => runTask(async () => {
              // The toast is about Talk, so it looks at the dictation shortcut alone.
              if (!(await finishSetup())) return;
              flash(usesFnKey(dictationHotkey) ? 'You’re set. Tap fn anywhere to talk.' : `You’re set. Press ${dictationHotkey || '⌘⇧D'} anywhere to talk.`, 5000);
            }, 'Couldn’t finish setup')}
          />
        ) : tab === 'eavesy' ? (
          <EavesyTab flash={flash} />
        ) : (
          <div className="ev-history">
            <CaptureHistory
              refreshRevision={historyRevision}
              openKey={opened}
              prompts={savedPrompts.prompts}
              promptsError={savedPrompts.error}
              onRetryPrompts={savedPrompts.reload}
              onPromptUsed={savedPrompts.used}
              liveId={live?.sessionId ?? null}
              hasLive={live !== null}
              dictationHotkey={dictationHotkey}
              signedIn={account === undefined ? undefined : account !== null}
              onSignIn={connect}
              flash={flash}
              runTask={runTask}
              searchRef={searchRef}
              searchSlot={searchSlot}
              scrollRef={historyRef}
            />
            <Composer
              ref={composerRef}
              dragActive={dragging}
              onSaveError={(error) => flash(errMsg(error, 'Couldn’t save that note'), 5000, 'warn')}
              onSaveNote={async (text) => {
                await saveNote(text);
                historyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              onFiles={pasteFromClipboard}
              onPick={() => runTask(async () => landed(await pickAndImportFiles()), 'Couldn’t add those files')}
              onEscapeEmpty={() => runTask(hidePanel)}
            />
          </div>
        )}
        <LauncherToast toast={toast} />
      </div>
    </div>
  );
}
