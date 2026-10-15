'use client';

import {
  ArrowLeft,
  Camera,
  Check,
  ClipboardPaste,
  Copy,
  CornerDownLeft,
  Download,
  FileText,
  FolderOpen,
  Globe,
  Keyboard,
  Loader2,
  Mic,
  MoreHorizontal,
  Pencil,
  Radio,
  Search,
  Settings,
  Sparkles,
  Square,
  Video,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useRouter } from '@/lib/next-compat/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  type CaptureSession,
  type CaptureStatus,
  completeSetup,
  copyText,
  getSettings,
  getCaptureStatus,
  captureScreenshot,
  getSetupStatus,
  hidePanel,
  resizePanel,
  relaunchApp,
  isDesktop,
  onLauncherOpened,
  onDictationHotkey,
  onLauncherSettings,
  onLauncherSetup,
  cancelPairing,
  errMsg,
  openPrivacySettings,
  type Permissions,
  type PrivacyPane,
  onLauncherRecordings,
  onCaptureState,
  onRecordingsUpdated,
  getSyncStatus,
  onSyncStatus,
  pairDevice,
  pasteClip,
  pasteToFrontmost,
  revealInFinder,
  checkPermissions,
  startAudioCapture,
  startScreenCapture,
  stopCapture,
  setPanelPinned,
  getAccountInfo,
  disconnectAccount,
  openWebApp,
} from '@/lib/desktop/bridge';
import { CaptureHistory, plainTranscript } from '@/components/launcher/capture-history';
import { includeComputerAudio, onCapturePrefsChanged, setIncludeComputerAudio } from '@/lib/desktop/capture-prefs';
import { PermissionRow } from '@/components/launcher/permission-row';
import { SettingsView, accountInitial, type AccountState } from '@/components/launcher/settings-view';
import { loadRecordings } from '@/lib/launcher/data';
import { score } from '@/lib/launcher/filter';
import { prettyAccel } from '@/lib/launcher/accel';
import type { Recording } from '@/lib/launcher/types';
import { cn, formatDuration } from '@/lib/utils';

export { plainTranscript };

function formatRelative(ms: number, now: number): string {
  const diff = now - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

const SOURCE_LABEL: Record<Recording['source'], string> = {
  system: 'System audio',
  mic: 'Microphone',
  both: 'Mic + system',
  dictation: 'Dictation',
  upload: 'Upload',
  screen: 'Screen + audio',
  screenshot: 'Screenshot',
  note: 'Note',
  image: 'Image',
};

function recordingMarkdown(rec: Recording): string {
  const when = new Date(rec.startedAt).toLocaleString();
  const lines = [
    `# ${rec.title}`,
    '',
    `_${when} · ${formatDuration(rec.durationSec * 1000)} · ${SOURCE_LABEL[rec.source]}_`,
    '',
  ];
  if (rec.summary) lines.push('## Summary', '', rec.summary, '');
  if (rec.transcript) lines.push('## Transcript', '', rec.transcript, '');
  return lines.join('\n');
}

function downloadMarkdown(rec: Recording) {
  const blob = new Blob([recordingMarkdown(rec)], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${rec.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 80) || 'recording'}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

interface Command {
  kind: 'command';
  id: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  keywords: string;
  run: () => void | Promise<void>;
}
interface RecordingRow {
  kind: 'recording';
  id: string;
  rec: Recording;
}
type Item = Command | RecordingRow;

interface Action {
  id: string;
  label: string;
  icon: ReactNode;
  hint?: string;
  destructive?: boolean;
  run: () => void | Promise<void>;
}

export function Launcher() {
  const router = useRouter();
  const desktop = isDesktop();
  const now = useRef(Date.now()).current;

  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionsQuery, setActionsQuery] = useState('');
  const [actionsSel, setActionsSel] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const captureBusy = useRef(false);
  const [starting, setStarting] = useState(false);
  const [view, setView] = useState<'setup' | 'list' | 'context' | 'settings'>(
    desktop ? 'setup' : 'list',
  );
  const [setupPaired, setSetupPaired] = useState(false);
  const [account, setAccount] = useState<AccountState>(undefined);
  const [connecting, setConnecting] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [withComputerAudio, setWithComputerAudio] = useState(false);
  useEffect(() => {
    setWithComputerAudio(includeComputerAudio());
    return onCapturePrefsChanged(() => setWithComputerAudio(includeComputerAudio()));
  }, []);
  const [setupPermissions, setSetupPermissions] = useState<Permissions | null>(null);
  const [checkingSetupPermissions, setCheckingSetupPermissions] = useState<'mic' | 'screen' | null>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [setupKnown, setSetupKnown] = useState(!desktop);
  const setupForced = useRef(false);
  const connectingRef = useRef(false);
  const [toggleHotkey, setToggleHotkey] = useState('⌘⇧Space');
  const [dictationHotkey, setDictationHotkey] = useState('');
  const [recording, setRecording] = useState<{
    session: CaptureSession;
    mode: 'audio' | 'screen';
  } | null>(null);
  const [capturePhase, setCapturePhase] = useState('idle');
  const [elapsed, setElapsed] = useState(0);

  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusPanel = useCallback(() => {
    const target = searchRef.current ?? panelRef.current;
    target?.focus({ preventScroll: true });
    searchRef.current?.select();
  }, []);
  const actionsInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const flash = useCallback((msg: string, ms = 1600) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), ms);
  }, []);

  const runTask = useCallback(
    (task: () => void | Promise<void>, fallback = 'That action could not be completed') => {
      void Promise.resolve()
        .then(task)
        .catch((error: unknown) => {
          flash(errMsg(error, fallback), 5000);
        });
    },
    [flash],
  );

  /** Reloads the list; on failure keeps what is shown and says the list is stale. */
  const refreshRecordings = useCallback(async () => {
    try {
      setRecordings(await loadRecordings(now));
      setLoadError(null);
    } catch (error) {
      setLoadError(errMsg(error, 'Could not load recordings'));
    }
  }, [now]);

  const pasteFromClipboard = useCallback(() => {
    runTask(async () => {
      try {
        await pasteClip();
        historyRef.current?.scrollTo({ top: 0 });
        flash('Saved to capture history');
      } catch (error) {
        throw new Error(errMsg(error, 'Could not paste from the clipboard'));
      }
    });
  }, [flash, runTask]);

  const refreshAccount = useCallback(async () => {
    if (!desktop) return;
    const info = await getAccountInfo();
    setAccount(info);
    setSetupPaired(info !== null);
  }, [desktop]);

  useEffect(() => { runTask(refreshAccount); }, [refreshAccount, runTask]);

  const refreshSetup = useCallback(
    async (chooseView = false) => {
      if (!desktop) return;
      try {
        const status = await getSetupStatus();
        if (status) setSetupPaired(status.paired);
        if (chooseView) {
          setView((current) =>
            current === 'settings' || (current === 'setup' && setupForced.current)
              ? current
              : status && !status.completed
                ? 'setup'
                : 'list',
          );
        }
      } finally {
        setSetupKnown(true);
      }
    },
    [desktop],
  );

  const keepPinned =
    desktop && (view === 'setup' || view === 'settings' || checkingSetupPermissions !== null || preflighting);
  useEffect(() => {
    if (!desktop) return;
    runTask(() => setPanelPinned(keepPinned), 'Could not keep settings open');
  }, [desktop, keepPinned, runTask]);

  const deniedPermission = useCallback(
    async (
      mode: 'audio' | 'screen',
      source: 'mixed' | 'system' | 'mic',
      withMic: boolean,
    ): Promise<string | null> => {
      const needsMic = mode === 'screen' ? withMic : source !== 'system';
      const needsScreen = mode === 'screen' || source !== 'mic';
      setPreflighting(true);
      let perms: Permissions | null;
      try {
        perms = await checkPermissions({ needScreen: needsScreen });
      } finally {
        setPreflighting(false);
      }
      if (!perms) return null;
      if ((needsMic && !perms.mic) || (needsScreen && !perms.screen)) {
        setSetupPermissions(perms);
        if (needsMic && !perms.mic) {
          setupForced.current = true;
          setView('setup');
        } else {
          setView('settings');
        }
      }
      if (needsMic && !perms.mic) {
        return 'Microphone access is off. Turn it on in System Settings → Privacy & Security → Microphone.';
      }
      if (needsScreen && !perms.screen) {
        return 'Screen Recording access is off. Turn it on in System Settings → Privacy & Security → Screen Recording, then quit and reopen Eavesy.';
      }
      return null;
    },
    [],
  );

  const beginRecording = useCallback(
    async (
      mode: 'audio' | 'screen',
      opts?: {
        source?: 'mixed' | 'system' | 'mic';
        mic?: boolean;
        contextBlurb?: string;
        dictation?: boolean;
      },
    ) => {
      if (captureBusy.current) return;
      captureBusy.current = true;
      const source = opts?.source ?? 'mixed';
      setStarting(true);
      try {
        const denied = await deniedPermission(mode, source, opts?.mic ?? false);
        if (denied) {
          flash(denied, 8000);
          return;
        }
        const session =
          mode === 'screen'
            ? await startScreenCapture(opts?.mic ?? false)
            : await startAudioCapture(source, opts?.contextBlurb, opts?.dictation);
        if (session) {
          setRecording({ session, mode });
          setView('list');
          setElapsed(0);
          await hidePanel();
        }
      } catch (e) {
        flash(errMsg(e, 'Could not start recording'), 8000);
      } finally {
        captureBusy.current = false;
        setStarting(false);
      }
    },
    [flash, deniedPermission],
  );

  const beginMeetingRecording = useCallback(() => {
    if (desktop) {
      setView('context');
      return;
    }
    void beginRecording('audio', { source: 'mixed' });
  }, [beginRecording, desktop]);

  const stopRecording = useCallback(async () => {
    if (!recording || captureBusy.current) return;
    captureBusy.current = true;
    const id = recording.session.session_id;
    try {
      await stopCapture(id);
      setRecording(null);
      flash('Recording saved');
      await refreshRecordings();
      setQuery('');
      setSelected(0);
    } catch (e) {
      flash(errMsg(e, 'Could not save recording'), 8000);
    } finally { captureBusy.current = false; }
  }, [recording, flash, refreshRecordings]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    runTask(async () => {
      const stopListening = await onDictationHotkey(() => {
        if (starting) return;
        if (recording) runTask(stopRecording);
        else runTask(() => beginRecording('audio', { source: 'mic', dictation: true }));
      });
      if (disposed) stopListening(); else unlisten = stopListening;
    });
    return () => { disposed = true; unlisten?.(); };
  }, [beginRecording, recording, runTask, starting, stopRecording]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    runTask(async () => {
      let receivedCaptureState = false;
      const applyCaptureState = (state: CaptureStatus) => {
        if (disposed) return;
        setCapturePhase(state.phase);
        if (state.phase === 'recording' && state.sessionId) {
          setRecording((current) => current?.session.session_id === state.sessionId ? current : {
            session: { session_id: state.sessionId!, started_at_ms: state.startedAtMs ?? Date.now(), mode: state.mode ?? 'audio', source: 'mixed' },
            mode: state.mode === 'screen' ? 'screen' : 'audio',
          });
        } else {
          setRecording((current) => current?.session.session_id === state.sessionId ? null : current);
        }
      };
      const listeners = await Promise.all([
        onLauncherSettings(() => setView('settings')),
        onLauncherRecordings(() => { setView((v) => (v === 'setup' ? v : 'list')); historyRef.current?.scrollTo({ top: 0 }); }),
        onLauncherSetup(() => { setupForced.current = true; setView('setup'); }),
        onCaptureState((state) => {
          receivedCaptureState = true;
          applyCaptureState(state);
        }),
      ]);
      const initial = await getCaptureStatus();
      if (!disposed && !receivedCaptureState && initial) applyCaptureState(initial);
      if (disposed) listeners.forEach((off) => off()); else unlisteners.push(...listeners);
    });
    return () => { disposed = true; unlisteners.forEach((off) => off()); };
  }, [runTask]);

  useEffect(() => {
    if (!recording) return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - (recording.session.started_at_ms ?? Date.now())) / 1000)));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [recording]);

  useEffect(() => {
    runTask(async () => {
      await refreshRecordings();
    }, 'Could not load recordings');
    runTask(async () => {
      const settings = await getSettings();
      if (settings?.toggle_hotkey) setToggleHotkey(prettyAccel(settings.toggle_hotkey));
      if (settings?.dictation_hotkey) setDictationHotkey(prettyAccel(settings.dictation_hotkey));
    }, 'Could not load desktop settings');
    runTask(() => refreshSetup(true), 'Could not load setup status');
  }, [refreshRecordings, refreshSetup, runTask]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    runTask(async () => {
      const stopListening = await onRecordingsUpdated(() => {
        runTask(async () => {
          await refreshRecordings();
        }, 'Could not refresh recordings');
      });
      if (disposed) stopListening();
      else unlisten = stopListening;
    }, 'Could not watch recording updates');
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshRecordings, runTask]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    runTask(async () => {
      const stopListening = await onSyncStatus((status) => setSignedOut(status.signedOut));
      const initial = await getSyncStatus();
      if (!disposed && initial) setSignedOut(initial.signedOut);
      if (disposed) stopListening();
      else unlisten = stopListening;
    }, 'Could not watch sync status');
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop, runTask]);

  useEffect(() => {
    focusPanel();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    runTask(async () => {
      const stopListening = await onLauncherOpened(() => {
        setupForced.current = false;
        setView((v) => (desktop && v === 'setup' ? v : 'list'));
        historyRef.current?.scrollTo({ top: 0 });
        setQuery('');
        setSelected(0);
        setActionsOpen(false);
        if (desktop) {
          runTask(() => refreshSetup(true), 'Could not refresh setup status');
          runTask(refreshAccount);
        } else setView('list');
        requestAnimationFrame(focusPanel);
      });
      if (disposed) stopListening();
      else unlisten = stopListening;
    }, 'Could not register the launcher shortcut');
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop, focusPanel, refreshSetup, refreshAccount, runTask]);

  const connectAccount = useCallback(async () => {
    if (!desktop || connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    try {
      await hidePanel();
      await pairDevice();
      flash('Account connected');
    } catch (error) {
      const message = errMsg(error, 'Could not connect account');
      if (!/cancelled/i.test(message)) flash(message, 6000);
    } finally {
      connectingRef.current = false;
      setConnecting(false);
      await refreshAccount();
      await refreshSetup(true);
    }
  }, [desktop, flash, refreshAccount, refreshSetup]);

  const cancelConnect = useCallback(() => {
    runTask(cancelPairing, 'Could not cancel sign-in');
  }, [runTask]);

  const refreshPermissionsQuietly = useCallback(async () => {
    const permissions = await checkPermissions({ prompt: false, needScreen: false });
    if (permissions) setSetupPermissions(permissions);
  }, []);

  const requestSetupPermission = useCallback(async (kind: 'mic' | 'screen') => {
    setCheckingSetupPermissions(kind);
    try {
      setSetupPermissions(await checkPermissions({ needScreen: kind === 'screen' }));
    } catch (error) {
      flash(errMsg(error, 'Could not check permissions'), 8000);
    } finally {
      setCheckingSetupPermissions(null);
    }
  }, [flash]);

  const openPrivacy = useCallback((pane: PrivacyPane) => {
    runTask(() => openPrivacySettings(pane), 'Could not open System Settings');
  }, [runTask]);

  const permissionsView = desktop && (view === 'setup' || view === 'settings');
  const allAllowed = !!setupPermissions?.mic && !!setupPermissions?.screen && !!setupPermissions?.accessibility;
  useEffect(() => {
    if (!permissionsView || allAllowed) return;
    let busy = false;
    const refresh = () => {
      if (busy) return;
      busy = true;
      void refreshPermissionsQuietly().catch(() => {}).finally(() => { busy = false; });
    };
    refresh();
    const id = window.setInterval(refresh, 2000);
    return () => window.clearInterval(id);
  }, [permissionsView, allAllowed, refreshPermissionsQuietly]);

  const finishSetup = useCallback(async () => {
    try {
      await completeSetup();
      setupForced.current = false;
      setView('list');
      searchRef.current?.focus();
    } catch (error) {
      flash(errMsg(error, 'Could not finish setup'));
    }
  }, [flash]);

  useEffect(() => {
    if (view !== 'setup' || recording || !setupPaired || !setupPermissions?.mic) return;
    const id = window.setTimeout(() => {
      runTask(async () => {
        await finishSetup();
        if (dictationHotkey) flash(`You're set. Press ${dictationHotkey} anywhere to record.`, 5000);
      }, 'Could not finish setup');
    }, 700);
    return () => window.clearTimeout(id);
  }, [view, recording, setupPaired, setupPermissions?.mic, finishSetup, runTask, flash, dictationHotkey]);

  const goSettings = useCallback(() => {
    if (desktop) {
      setView('settings');
      return;
    }
    runTask(() => router.push('/app/settings'), 'Could not open settings');
  }, [desktop, router, runTask]);

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => {
      if (desktop) runTask(hidePanel, 'Could not close the launcher');
      runTask(() => router.push(href), 'Could not open that page');
    };
    return [
      {
        kind: 'command',
        id: 'cmd-connect',
        title: 'Connect Eavesy account',
        subtitle: 'Pair this Mac for cloud transcription and sync',
        icon: <Globe className="h-4 w-4" />,
        keywords: 'connect account pair login sync cloud',
        run: () => runTask(connectAccount, 'Could not connect account'),
      },
      {
        kind: 'command',
        id: 'cmd-record',
        title: 'Record audio',
        subtitle: 'Capture system audio + microphone',
        icon: <Radio className="h-4 w-4" />,
        keywords: 'record capture meeting audio new mic',
        run: beginMeetingRecording,
      },
      {
        kind: 'command',
        id: 'cmd-screen',
        title: 'Record screen',
        subtitle: 'Screen + audio, Loom-style — with transcript',
        icon: <Video className="h-4 w-4" />,
        keywords: 'record screen video loom capture share demo',
        run: () =>
          runTask(
            () => beginRecording('screen', { mic: false }),
            'Could not start screen recording',
          ),
      },
      {
        kind: 'command',
        id: 'cmd-dictate',
        title: 'Start dictation',
        subtitle: 'Record your voice, then copy or paste the transcript',
        icon: <Mic className="h-4 w-4" />,
        keywords: 'dictate voice type speech',
        run: () =>
          runTask(
            () => beginRecording('audio', { source: 'mic', dictation: true }),
            'Could not start dictation',
          ),
      },
      {
        kind: 'command',
        id: 'cmd-note',
        title: 'New note',
        subtitle: 'Start an empty note',
        icon: <Pencil className="h-4 w-4" />,
        keywords: 'note write text new',
        run: go('/app/record'),
      },
      {
        kind: 'command',
        id: 'cmd-dashboard',
        title: 'Open dashboard',
        subtitle: 'All recordings on the web',
        icon: <Globe className="h-4 w-4" />,
        keywords: 'dashboard web app open all',
        run: go('/app'),
      },
      {
        kind: 'command',
        id: 'cmd-settings',
        title: 'Settings & hotkeys',
        subtitle: 'Change your global shortcut',
        icon: <Settings className="h-4 w-4" />,
        keywords: 'settings hotkey shortcut preferences config',
        run: goSettings,
      },
    ];
  }, [
    desktop,
    router,
    beginRecording,
    beginMeetingRecording,
    connectAccount,
    goSettings,
    runTask,
  ]);

  const { items, commandCount } = useMemo(() => {
    const q = query.trim();
    const cmds = (q ? commands : [])
      .map((c) => ({ c, s: score(q, c.title, c.keywords) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c as Item);

    const recs = recordings
      .map((rec) => ({
        rec,
        s: score(q, rec.title, `${rec.summary ?? ''} ${rec.transcript ?? ''}`),
      }))
      .filter((x) => x.s >= 0)
      .sort((a, b) =>
        b.s === a.s ? b.rec.startedAt - a.rec.startedAt : b.s - a.s,
      )
      .map((x): RecordingRow => ({ kind: 'recording', id: x.rec.id, rec: x.rec }));

    return { items: [...cmds, ...recs], commandCount: cmds.length };
  }, [commands, recordings, query]);

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items.length]);

  const current = items[selected];
  const currentRec = current?.kind === 'recording' ? current.rec : null;

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${selected}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const actions = useMemo<Action[]>(() => {
    if (current?.kind === 'command') {
      return [
        {
          id: 'run',
          label: `Run “${current.title}”`,
          icon: <CornerDownLeft className="h-4 w-4" />,
          hint: '↵',
          run: current.run,
        },
      ];
    }
    if (!currentRec) return [];
    const rec = currentRec;
    const transcript = rec.transcript ?? '';
    const summary = rec.summary ?? '';
    const close = () => setActionsOpen(false);
    return [
      {
        id: 'paste',
        label: 'Paste transcript into active app',
        icon: <CornerDownLeft className="h-4 w-4" />,
        hint: '⌘↵',
        run: async () => {
          await pasteToFrontmost(transcript);
          close();
          if (!desktop) flash('Transcript copied — paste anywhere');
        },
      },
      {
        id: 'copy-transcript',
        label: 'Copy transcript',
        icon: <Copy className="h-4 w-4" />,
        hint: '⌘C',
        run: async () => {
          await copyText(transcript);
          close();
          flash('Transcript copied');
        },
      },
      {
        id: 'copy-summary',
        label: 'Copy summary',
        icon: <FileText className="h-4 w-4" />,
        hint: '⌘⇧C',
        run: async () => {
          await copyText(summary || transcript);
          close();
          flash('Summary copied');
        },
      },
      {
        id: 'copy-md',
        label: 'Copy as Markdown',
        icon: <Copy className="h-4 w-4" />,
        run: async () => {
          await copyText(recordingMarkdown(rec));
          close();
          flash('Markdown copied');
        },
      },
      {
        id: 'ask-ai',
        label: 'Copy as AI prompt',
        icon: <Sparkles className="h-4 w-4" />,
        hint: '⌘J',
        run: async () => {
          await copyText(
            `Here is a meeting transcript. Summarize the key decisions and action items.\n\n---\n${transcript}`,
          );
          close();
          flash('Prompt copied — paste into your AI');
        },
      },
      {
        id: 'download',
        label: 'Download as Markdown',
        icon: <Download className="h-4 w-4" />,
        hint: '⌘D',
        run: () => {
          downloadMarkdown(rec);
          close();
        },
      },
      ...(desktop
        ? [
            {
              id: 'reveal',
              label: 'Reveal in Finder',
              icon: <FolderOpen className="h-4 w-4" />,
              hint: '⌘⇧R',
              run: () => {
                runTask(() => revealInFinder(rec.id), 'Could not reveal recording');
                close();
              },
            } as Action,
          ]
        : []),
      {
        id: 'open',
        label: 'Open recording',
        icon: <Globe className="h-4 w-4" />,
        run: () => openRecording(rec),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, currentRec, desktop, flash, runTask]);

  const filteredActions = useMemo(() => {
    const q = actionsQuery.trim();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()));
  }, [actions, actionsQuery]);

  useEffect(() => {
    setActionsSel((s) => Math.min(s, Math.max(0, filteredActions.length - 1)));
  }, [filteredActions.length]);

  const openRecording = useCallback(
    (rec: Recording) => {
      if (rec.id.startsWith('demo_')) {
        flash('Demo recording — sign in to open');
        return;
      }
      if (desktop) runTask(hidePanel, 'Could not close the launcher');
      runTask(
        () => router.push(`/app/meetings/${rec.id}`),
        'Could not open recording',
      );
    },
    [desktop, router, flash, runTask],
  );

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

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key === ',') { e.preventDefault(); goSettings(); return; }
      if (desktop && view === 'list' && meta && e.key.toLowerCase() === 'v' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        pasteFromClipboard();
        return;
      }
      if (view === 'settings') {
        if (e.key === 'Escape') { e.preventDefault(); setView('list'); }
        return;
      }
      if (view === 'setup') {
        if (e.key === 'Escape' && desktop) {
          e.preventDefault();
          runTask(hidePanel, 'Could not close the launcher');
        }
        return;
      }
      if (view === 'context') {
        if (e.key === 'Escape') {
          e.preventDefault();
          setView('list');
        }
        return;
      }

      if (actionsOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setActionsOpen(false);
          searchRef.current?.focus();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActionsSel((s) => (s + 1) % Math.max(1, filteredActions.length));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActionsSel(
            (s) =>
              (s - 1 + filteredActions.length) %
              Math.max(1, filteredActions.length),
          );
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const action = filteredActions[actionsSel];
          if (action) runTask(action.run);
        } else if (meta && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          setActionsOpen(false);
        }
        return;
      }

      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openActions();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => (items.length ? (s + 1) % items.length : 0));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) =>
          items.length ? (s - 1 + items.length) % items.length : 0,
        );
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (meta && currentRec) {
          runTask(
            () => pasteToFrontmost(currentRec.transcript ?? ''),
            'Could not paste transcript',
          );
          if (!desktop) flash('Transcript copied — paste anywhere');
        } else {
          runPrimary();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (query) {
          setQuery('');
        } else if (desktop) {
          runTask(hidePanel, 'Could not close the launcher');
        }
        return;
      }
      if (meta && currentRec) {
        const k = e.key.toLowerCase();
        if (k === 'c' && !e.shiftKey) {
          e.preventDefault();
          runTask(async () => {
            await copyText(currentRec.transcript ?? '');
            flash('Transcript copied');
          }, 'Could not copy transcript');
        } else if (k === 'c' && e.shiftKey) {
          e.preventDefault();
          runTask(async () => {
            await copyText(currentRec.summary ?? currentRec.transcript ?? '');
            flash('Summary copied');
          }, 'Could not copy summary');
        } else if (k === 'd') {
          e.preventDefault();
          downloadMarkdown(currentRec);
        } else if (k === 'j') {
          e.preventDefault();
          runTask(async () => {
            await copyText(
              `Here is a meeting transcript. Summarize the key decisions and action items.\n\n---\n${currentRec.transcript ?? ''}`,
            );
            flash('Prompt copied');
          }, 'Could not copy prompt');
        }
      }
    },
    [
      actionsOpen,
      filteredActions,
      actionsSel,
      items.length,
      currentRec,
      query,
      desktop,
      view,
      runPrimary,
      goSettings,
      openActions,
      flash,
      runTask,
      pasteFromClipboard,
    ],
  );

  return (
    <div
      className={cn(
        'launcher-scope fixed inset-0 flex',
        desktop ? 'items-stretch justify-stretch' : 'items-center justify-center',
      )}
      data-desktop={desktop ? 'true' : 'false'}
    >
      {!desktop && <div className="launcher-scrim absolute inset-0" />}
      <div
        className={cn(
          'launcher-panel relative z-10 flex flex-col overflow-hidden border border-border',
          desktop
            ?
              'h-full w-full rounded-[12px]'
            : 'h-[min(460px,92vh)] w-[min(92vw,720px)] rounded-2xl',
          'outline-none',
        )}
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {desktop && <ResizeHandles />}
        {desktop && (
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
        )}
        {desktop && view === 'list' && <div className="flex h-9 shrink-0 items-center justify-around border-b border-border px-2 text-[11px] text-muted-foreground">
          <span className="flex items-center">
            <button type="button" aria-label={recording ? 'Stop & save' : withComputerAudio ? 'Record mic and computer audio' : 'Start voice note'} disabled={starting} title={dictationHotkey ? `${recording ? 'Stop & save' : 'Start recording'} from anywhere with ${dictationHotkey}` : undefined} onClick={() => recording ? runTask(stopRecording) : runTask(() => beginRecording('audio', { source: withComputerAudio ? 'mixed' : 'mic' }))} className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[var(--lr-brand)] hover:bg-[var(--lr-brand-soft)]">{recording ? <Square className="h-3.5 w-3.5" fill="currentColor" /> : <Mic className="h-3.5 w-3.5" />} {recording ? 'Stop' : 'Microphone'}{dictationHotkey && <kbd className="ml-0.5 font-sans text-[10px] tracking-wide text-muted-foreground/70">{dictationHotkey}</kbd>}</button>
            {!recording && <button type="button" aria-pressed={withComputerAudio} onClick={() => setIncludeComputerAudio(!withComputerAudio)} title={withComputerAudio ? 'Recording computer audio too (calls and meetings). Click to record only your mic.' : 'Also record computer audio, for calls and meetings'} aria-label="Include computer audio" className={cn('grid h-6 w-6 place-items-center rounded-full', withComputerAudio ? 'bg-[var(--lr-brand-soft)] text-[var(--lr-brand)]' : 'text-muted-foreground hover:bg-[var(--lr-hover)]')}>{withComputerAudio ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}</button>}
          </span>
          <button type="button" aria-label="Take screenshot" disabled={starting || !!recording} onClick={() => runTask(async () => { if (captureBusy.current) return; captureBusy.current = true; setStarting(true); try { await captureScreenshot(); } finally { captureBusy.current = false; setStarting(false); } })} className="flex items-center gap-1.5 rounded-full px-2 py-1 hover:bg-[var(--lr-hover)] disabled:opacity-40"><Camera className="h-3.5 w-3.5" /> Screenshot</button>
          <button type="button" aria-label="Record screen video" disabled={starting || !!recording} onClick={() => runTask(() => beginRecording('screen', { mic: true }))} className="flex items-center gap-1.5 rounded-full px-2 py-1 hover:bg-[var(--lr-hover)] disabled:opacity-40"><Video className="h-3.5 w-3.5" /> Video</button>
        </div>}
        {desktop && view === 'list' && signedOut && (
          <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-[var(--lr-brand-soft)] px-4 py-2 text-xs">
            <span>Eavesy is signed out. Recordings stay on this Mac and upload once you reconnect.</span>
            <button type="button" disabled={connecting} onClick={() => runTask(connectAccount, 'Could not connect account')} className="shrink-0 rounded-md bg-[var(--lr-brand)] px-2 py-1 text-white disabled:opacity-50">Reconnect</button>
          </div>
        )}
        {desktop && !setupKnown ? (
          <div className="min-h-0 flex-1" aria-busy="true" />
        ) : view === 'setup' && !recording ? (
          <SetupView
            paired={setupPaired}
            connecting={connecting}
            permissions={setupPermissions}
            checking={checkingSetupPermissions}
            onConnect={() => runTask(connectAccount, 'Could not connect account')}
            onCancelConnect={cancelConnect}
            onRequest={(kind) => runTask(() => requestSetupPermission(kind), 'Could not check permissions')}
            onOpenSettings={openPrivacy}
            onFinish={() => runTask(finishSetup, 'Could not finish setup')}
          />
        ) : view === 'settings' ? (
          <SettingsView
            permissions={setupPermissions}
            checkingPermission={checkingSetupPermissions}
            onRequestPermission={(kind) => runTask(() => requestSetupPermission(kind), 'Could not check permissions')}
            onOpenPrivacy={openPrivacy}
            onRelaunch={() => runTask(relaunchApp, 'Could not reopen Eavesy')}
            account={account}
            connecting={connecting}
            onCancelConnect={cancelConnect}
            onDisconnect={() => runTask(async () => { await disconnectAccount(); await refreshAccount(); flash('Signed out on this Mac'); })}
            onShortcutsChanged={() => runTask(async () => {
              const saved = await getSettings();
              if (saved) {
                setToggleHotkey(prettyAccel(saved.toggle_hotkey));
                setDictationHotkey(prettyAccel(saved.dictation_hotkey));
              }
            })}
            onBack={() => setView('list')}
            onConnect={() => runTask(connectAccount, 'Could not connect account')}
            onOpenWeb={() => runTask(openWebApp, 'Could not open the web app')}
          />
        ) : starting && !recording ? (
          <StartingView />
        ) : view === 'context' && !recording ? (
          <ContextView
            onBack={() => setView('list')}
            onStart={(contextBlurb) =>
              runTask(
                () => beginRecording('audio', { source: 'mixed', contextBlurb }),
                'Could not start recording',
              )
            }
          />
        ) : recording && !desktop ? (
          <RecordingView
            mode={recording.mode}
            elapsed={elapsed}
            onStop={() => runTask(stopRecording, 'Could not stop recording')}
          />
        ) : desktop ? (
          <div ref={historyRef} data-capture-history className="min-h-0 flex-1 overflow-y-auto p-4 [overflow-anchor:none]">
            {loadError && (
              <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs">
                <span>Couldn’t load your recordings: {loadError}</span>
                <button type="button" onClick={() => runTask(refreshRecordings)} className="shrink-0 rounded-md px-2 py-1 hover:bg-[var(--lr-hover)]">Retry</button>
              </div>
            )}
            <CaptureHistory signedIn={account !== null} onSignIn={() => runTask(connectAccount, 'Could not connect account')} recordings={recordings} onPaste={pasteFromClipboard} onCopied={(message) => flash(message)} onError={(error) => flash(errMsg(error, 'Could not copy'), 5000)} />
          </div>
        ) : (
          <>
        {!query && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
            <RecordButton icon={<Radio className="h-4 w-4" />} label="Record meeting" primary onClick={beginMeetingRecording} />
            <RecordButton icon={<Mic className="h-4 w-4" />} label="Dictate" onClick={() => runTask(() => beginRecording('audio', { source: 'mic', dictation: true }))} />
            <span className="ml-auto text-[11px] text-muted-foreground">{desktop ? (setupPaired ? 'Cloud connected' : 'Local only · Connect in Settings') : 'Record, find, and reuse your conversations'}</span>
          </div>
        )}
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="h-5 w-5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            placeholder="Search recordings, transcripts, commands…"
            spellCheck={false}
            autoComplete="off"
            className="h-14 w-full bg-transparent text-[17px] text-foreground caret-[var(--lr-brand)] outline-none placeholder:text-muted-foreground"
          />
          {!query && (
            <div className="lr-eq shrink-0 pr-0.5" aria-hidden="true">
              <i style={{ height: '40%', animationDelay: '0ms' }} />
              <i style={{ height: '90%', animationDelay: '130ms' }} />
              <i style={{ height: '55%', animationDelay: '260ms' }} />
              <i style={{ height: '100%', animationDelay: '80ms' }} />
              <i style={{ height: '45%', animationDelay: '340ms' }} />
            </div>
          )}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
          <div
            ref={listRef}
            className="launcher-list min-h-0 overflow-y-auto border-r border-border py-2"
          >
            {items.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                {query ? `No matches for “${query}”.` : 'Your recordings will appear here. Start a meeting or dictate above.'}
              </p>
            )}
            {items.map((item, i) => {
              const isFirstRec =
                item.kind === 'recording' && i === commandCount;
              const isFirstCmd = item.kind === 'command' && i === 0;
              return (
                <div key={item.id}>
                  {isFirstCmd && <SectionLabel>Commands</SectionLabel>}
                  {isFirstRec && <SectionLabel>Recordings</SectionLabel>}
                  <Row
                    item={item}
                    now={now}
                    active={i === selected}
                    idx={i}
                    onClick={() => setSelected(i)}
                    onDoubleClick={() => runPrimary()}
                  />
                </div>
              );
            })}
          </div>

          <div className="relative flex min-h-0 flex-col">
            <div className="flex h-12 shrink-0 items-center justify-between gap-1.5 border-b border-border px-3">
              {currentRec ? (
                <>
                  <span />
                  <div className="flex items-center gap-1.5">
                    <ToolbarBtn
                      title="Copy transcript"
                      onClick={() =>
                        runTask(async () => {
                          await copyText(currentRec.transcript ?? '');
                          flash('Transcript copied');
                        }, 'Could not copy transcript')
                      }
                    >
                      <Copy className="h-4 w-4" />
                    </ToolbarBtn>
                    <ToolbarBtn
                      title="Paste into active app"
                      onClick={() => {
                        runTask(
                          () => pasteToFrontmost(currentRec.transcript ?? ''),
                          'Could not paste transcript',
                        );
                        if (!desktop) flash('Transcript copied — paste anywhere');
                      }}
                    >
                      <ClipboardPaste className="h-4 w-4" />
                    </ToolbarBtn>
                    <ToolbarBtn
                      title="Download as Markdown"
                      onClick={() => downloadMarkdown(currentRec)}
                    >
                      <Download className="h-4 w-4" />
                    </ToolbarBtn>
                    <ToolbarBtn
                      title="More actions"
                      active={actionsOpen}
                      onClick={() =>
                        actionsOpen ? setActionsOpen(false) : openActions()
                      }
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </ToolbarBtn>
                  </div>
                </>
              ) : (
                <>
                  <span className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                    New recording
                  </span>
                  <div className="flex items-center gap-2">
                    <RecordButton
                      icon={<Mic className="h-4 w-4" />}
                      label="Audio"
                      primary
                      onClick={beginMeetingRecording}
                    />
                    <RecordButton
                      icon={<Video className="h-4 w-4" />}
                      label="Screen"
                      onClick={() =>
                        runTask(
                          () => beginRecording('screen', { mic: false }),
                          'Could not start screen recording',
                        )
                      }
                    />
                  </div>
                </>
              )}
            </div>

            <Preview
              rec={currentRec}
              command={current?.kind === 'command' ? current : null}
              now={now}
            />

            {actionsOpen && (
              <ActionsMenu
                actions={filteredActions}
                selected={actionsSel}
                query={actionsQuery}
                inputRef={actionsInputRef}
                onQuery={(v) => {
                  setActionsQuery(v);
                  setActionsSel(0);
                }}
                onHover={setActionsSel}
                onRun={(action) => runTask(action.run)}
                onKeyDown={onKeyDown}
              />
            )}
          </div>
        </div>

        <div className="flex h-12 items-center justify-between border-t border-border px-4">
          <div className="flex items-center gap-2">
            <span
              className="grid h-5 w-5 place-items-center rounded-full"
              style={{ background: 'var(--lr-brand-soft)' }}
              aria-hidden="true"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: 'var(--lr-brand)' }}
              />
            </span>
            <span className="text-[13px] font-medium text-foreground">
              Eavesy
            </span>
          </div>
          <button
            type="button"
            onClick={goSettings}
            title="Change your launcher hotkey"
            className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-[var(--lr-hover)]"
          >
            <Keyboard className="h-4 w-4" />
            <span>Settings · Open</span>
            <span
              className="rounded-md border px-1.5 py-0.5 font-mono text-[12px] text-foreground"
              style={{
                borderColor:
                  'color-mix(in srgb, var(--lr-brand) 45%, var(--border))',
              }}
            >
              {toggleHotkey}
            </span>
          </button>
        </div>
          </>
        )}

        {toast && (
          <div className="pointer-events-none absolute bottom-14 left-1/2 z-20 -translate-x-1/2 rounded-md bg-foreground px-3 py-1.5 text-[13px] font-medium text-background shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

type ResizeEdge = 'left' | 'right' | 'bottom' | 'bottom-left' | 'bottom-right';

const RESIZE_EDGES: { edge: ResizeEdge; className: string }[] = [
  { edge: 'left', className: 'left-0 top-11 bottom-3 w-2 cursor-ew-resize' },
  { edge: 'right', className: 'right-0 top-11 bottom-3 w-2 cursor-ew-resize' },
  { edge: 'bottom', className: 'bottom-0 left-3 right-3 h-2 cursor-ns-resize' },
  { edge: 'bottom-left', className: 'bottom-0 left-0 h-3 w-3 cursor-nesw-resize' },
  { edge: 'bottom-right', className: 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize' },
];

function ResizeHandles() {
  const start = (edge: ResizeEdge) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const origin = { x: e.screenX, y: e.screenY, width: window.innerWidth, height: window.innerHeight };
    let pending: { width: number; height: number } | null = null;
    let inFlight = false;
    const flush = () => {
      if (inFlight || !pending) return;
      const next = pending;
      pending = null;
      inFlight = true;
      void resizePanel(next.width, next.height)
        .catch(() => {})
        .finally(() => { inFlight = false; flush(); });
    };
    const move = (ev: PointerEvent) => {
      const dx = ev.screenX - origin.x;
      const dy = ev.screenY - origin.y;
      const widthDelta = edge.includes('right') ? dx * 2 : edge.includes('left') ? -dx * 2 : 0;
      const heightDelta = edge.startsWith('bottom') ? dy : 0;
      pending = { width: origin.width + widthDelta, height: origin.height + heightDelta };
      flush();
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  return (
    <>
      {RESIZE_EDGES.map(({ edge, className }) => (
        <div key={edge} aria-hidden="true" onPointerDown={start(edge)} className={cn('absolute z-30', className)} />
      ))}
    </>
  );
}

function SetupView({
  paired,
  connecting,
  permissions,
  checking,
  onConnect,
  onCancelConnect,
  onRequest,
  onOpenSettings,
  onFinish,
}: {
  paired: boolean;
  connecting: boolean;
  permissions: Permissions | null;
  checking: 'mic' | 'screen' | null;
  onConnect: () => void;
  onCancelConnect: () => void;
  onRequest: (kind: 'mic' | 'screen') => void;
  onOpenSettings: (pane: PrivacyPane) => void;
  onFinish: () => void;
}) {
  const micReady = permissions?.mic === true;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-4">
        <h2 className="text-[15px] font-semibold text-foreground">Set up Eavesy</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Two quick steps, then you&apos;re recording.</p>

        <SetupSection step={1} title="Sign in" complete={paired}>
          {paired ? (
            <p className="text-xs text-muted-foreground">Signed in. Transcripts and summaries sync to your account.</p>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Turns recordings into transcripts and summaries you can search anywhere.
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={onConnect}
                  disabled={connecting}
                  className="inline-flex h-8 items-center gap-2 rounded-lg bg-[var(--lr-brand)] px-3 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 active:brightness-95 disabled:opacity-70"
                >
                  {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
                  {connecting ? 'Finish in your browser…' : 'Sign in with browser'}
                </button>
                {connecting && (
                  <button type="button" onClick={onCancelConnect} className="h-8 rounded-lg px-2 text-xs text-muted-foreground hover:bg-[var(--lr-hover)] hover:text-foreground">
                    Cancel
                  </button>
                )}
              </div>
            </>
          )}
        </SetupSection>

        <SetupSection step={2} title="Allow the microphone" complete={micReady}>
          <div className="-mx-2 grid">
            <PermissionRow
              label="Microphone"
              hint="Needed for voice notes and dictation."
              settingsHint="Turn on Eavesy under Microphone in System Settings. This page updates on its own."
              granted={permissions?.mic}
              answered={permissions?.micAsked}
              checking={checking === 'mic'}
              onRequest={() => onRequest('mic')}
              onOpenSettings={() => onOpenSettings('microphone')}
            />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">Screen Recording and pasting into other apps can be turned on later in Settings.</p>
        </SetupSection>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2.5">
        <span className="min-w-0 text-[11px] leading-snug text-muted-foreground">
          Eavesy lives in your menu bar. Recordings stay in ~/Eavesy.
        </span>
        {paired && micReady ? (
          <span className="inline-flex h-8 shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-500">
            <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> All set
          </span>
        ) : (
          <button
            type="button"
            onClick={onFinish}
            disabled={!micReady}
            title={micReady ? 'Use Eavesy without an account. Recordings stay on this Mac.' : 'Allow the microphone first'}
            className="h-8 shrink-0 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-[var(--lr-hover)] hover:text-foreground disabled:opacity-40"
          >
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
}

function SetupSection({
  step,
  title,
  complete,
  children,
}: {
  step: number;
  title: string;
  complete: boolean;
  children: ReactNode;
}) {
  return (
    <section className="mt-4 flex gap-3">
      <span
        className={cn(
          'mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold',
          complete ? 'bg-emerald-500 text-white' : 'border border-border text-muted-foreground',
        )}
        aria-hidden="true"
      >
        {complete ? <Check className="h-3 w-3" strokeWidth={3} /> : step}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-medium leading-5 text-foreground">{title}</h3>
        <div className="mt-1">{children}</div>
      </div>
    </section>
  );
}

function ContextView({
  onBack,
  onStart,
}: {
  onBack: () => void;
  onStart: (contextBlurb?: string) => void;
}) {
  const [context, setContext] = useState('');
  const start = () => onStart(context.trim() || undefined);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1 text-muted-foreground hover:bg-[var(--lr-hover)] hover:text-foreground"
          aria-label="Back"
          title="Back (esc)"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-sm font-semibold text-foreground">New meeting recording</h2>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center px-8 py-6">
        <label htmlFor="meeting-context" className="text-sm font-medium text-foreground">
          Help Eavesy understand the meeting
        </label>
        <p className="mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
          Optional: add participant names, the project, or the outcome you care about. This becomes
          private ground truth for the summary when speaker labels are unavailable.
        </p>
        <textarea
          id="meeting-context"
          value={context}
          onChange={(event) => setContext(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              start();
            }
          }}
          autoFocus
          rows={4}
          maxLength={1000}
          placeholder="Example: Weekly product review with Maya and Alex. Focus on launch blockers and owners."
          className="mt-4 resize-none rounded-lg border border-border bg-transparent p-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-[var(--lr-brand)]"
        />
        <div className="mt-4 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">⌘↵ to start · {context.length}/1000</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onStart()}
              className="rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-[var(--lr-hover)]"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={start}
              className="inline-flex items-center gap-2 rounded-md bg-[var(--lr-brand)] px-4 py-2 text-xs font-semibold text-white"
            >
              <Radio className="h-3.5 w-3.5" /> Start recording
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

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

function RecordingView({
  mode,
  elapsed,
  onStop,
}: {
  mode: 'audio' | 'screen';
  elapsed: number;
  onStop: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-7 p-8">
      <div className="flex items-center gap-2.5">
        <span
          className="h-3 w-3 animate-recording-pulse rounded-full"
          style={{ background: '#ef4444' }}
        />
        <span className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
          Recording {mode === 'screen' ? 'screen + audio' : 'audio'}
        </span>
      </div>
      <div className="font-mono text-6xl font-medium tabular-nums text-foreground">
        {mmss(elapsed)}
      </div>
      <button
        type="button"
        onClick={onStop}
        className="flex items-center gap-2 rounded-lg px-6 py-3 text-[14px] font-medium text-white"
        style={{ background: '#ef4444' }}
      >
        <Square className="h-4 w-4" fill="currentColor" /> Stop &amp; save
      </button>
      <p className="text-[12px] text-muted-foreground">
        Saving to ~/Eavesy/Recordings
      </p>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

function RecordButton({
  icon,
  label,
  primary,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-opacity hover:opacity-90"
      style={
        primary
          ? { background: 'var(--lr-brand)', color: '#fff' }
          : {
              border: '1px solid var(--lr-brand)',
              color: 'var(--lr-brand)',
              background: 'var(--lr-brand-soft)',
            }
      }
    >
      {icon}
      {label}
    </button>
  );
}

function ToolbarBtn({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        'grid h-8 w-8 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:text-foreground',
        active ? 'text-foreground' : '',
      )}
      style={
        active
          ? { background: 'var(--lr-brand-soft)', color: 'var(--lr-brand)' }
          : { background: 'color-mix(in srgb, var(--background) 60%, transparent)' }
      }
    >
      {children}
    </button>
  );
}

function Row({
  item,
  active,
  idx,
  now,
  onClick,
  onDoubleClick,
}: {
  item: Item;
  active: boolean;
  idx: number;
  now: number;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  const title = item.kind === 'command' ? item.title : item.rec.title;
  const icon =
    item.kind === 'command' ? (
      item.icon
    ) : item.rec.hasVideo || item.rec.source === 'screen' ? (
      <Video className="h-4 w-4" />
    ) : item.rec.source === 'dictation' ? (
      <Mic className="h-4 w-4" />
    ) : (
      <FileText className="h-4 w-4" />
    );
  const subtitle =
    item.kind === 'command'
      ? item.subtitle
      : `${SOURCE_LABEL[item.rec.source]} · ${formatDuration(item.rec.durationSec * 1000)}`;

  return (
    <button
      type="button"
      data-idx={idx}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        'flex w-full items-center gap-3 px-3 py-2 text-left',
        active ? 'lr-row-active' : 'hover:bg-[var(--lr-hover)]',
      )}
    >
      <span
        className={cn(
          'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
          item.kind === 'command'
            ? 'bg-[var(--lr-brand-soft)] text-[var(--lr-brand)]'
            : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-foreground">
          {title}
        </span>
        <span className="block truncate text-[12px] text-muted-foreground">
          {subtitle}
        </span>
      </span>
      {item.kind === 'recording' && (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {item.rec.status === 'recording'
            ? 'live'
            : item.rec.status === 'processing'
              ? 'transcribing…'
              : item.rec.status === 'transcript_failed'
                ? 'no transcript'
                : formatRelative(item.rec.startedAt, now)}
        </span>
      )}
    </button>
  );
}

function Preview({
  rec,
  command,
  now,
}: {
  rec: Recording | null;
  command: Command | null;
  now: number;
}) {
  if (command) {
    return (
      <div className="launcher-preview min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mb-3 flex items-center gap-2 text-[var(--lr-brand)]">
          {command.icon}
          <span className="text-[15px] font-medium text-foreground">
            {command.title}
          </span>
        </div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {command.subtitle}
        </p>
      </div>
    );
  }
  if (!rec) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-center text-[13px] text-muted-foreground">
        Select a recording to preview its transcript.
      </div>
    );
  }
  return (
    <div className="launcher-preview min-h-0 overflow-y-auto p-5">
      <h2 className="text-[15px] font-semibold text-foreground">{rec.title}</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        {new Date(rec.startedAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })}{' '}
        · {formatDuration(rec.durationSec * 1000)} · {SOURCE_LABEL[rec.source]}
        {' · '}
        {formatRelative(rec.startedAt, now)}
      </p>
      {rec.summary && (
        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Summary
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-foreground">
            {rec.summary}
          </p>
        </div>
      )}
      {!rec.transcript && rec.status === 'processing' && (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-muted-foreground">
          <span
            className="h-2 w-2 animate-recording-pulse rounded-full"
            style={{ background: 'var(--lr-brand)' }}
          />
          Transcribing…
        </div>
      )}
      {!rec.transcript && rec.status === 'transcript_failed' && (
        <div className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          Transcript unavailable — transcription failed. The audio is saved
          in your Eavesy folder.
        </div>
      )}
      {rec.transcript && (
        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Transcript
          </p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
            {rec.transcript}
          </p>
        </div>
      )}
    </div>
  );
}

function ActionsMenu({
  actions,
  selected,
  query,
  inputRef,
  onQuery,
  onHover,
  onRun,
  onKeyDown,
}: {
  actions: Action[];
  selected: number;
  query: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onQuery: (v: string) => void;
  onHover: (i: number) => void;
  onRun: (a: Action) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={() => onQuery('')} />
      <div className="launcher-panel absolute right-3 top-14 z-30 w-72 overflow-hidden rounded-xl border border-border">
        <div className="launcher-actions max-h-72 overflow-y-auto p-1.5">
          {actions.length === 0 && (
            <p className="px-2 py-3 text-[13px] text-muted-foreground">
              No actions.
            </p>
          )}
          {actions.map((a, i) => (
            <button
              key={a.id}
              type="button"
              onMouseMove={() => onHover(i)}
              onClick={() => onRun(a)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px]',
                i === selected ? 'bg-[var(--lr-selected)]' : '',
                a.destructive ? 'text-danger' : 'text-foreground',
              )}
            >
              <span className={a.destructive ? 'text-danger' : 'text-muted-foreground'}>
                {a.icon}
              </span>
              <span className="flex-1 truncate">{a.label}</span>
              {a.hint && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {a.hint}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="border-t border-border px-2 py-1.5">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search actions…"
            spellCheck={false}
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
    </>
  );
}
