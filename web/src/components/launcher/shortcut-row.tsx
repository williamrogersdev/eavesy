'use client';

import { RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton, Kbd, Mascot, StatusDisc } from '@/components/launcher/ui';
import {
  checkAllHotkeys,
  checkHotkey,
  errMsg,
  fnStatus,
  getHotkeyDefaults,
  getSettings,
  isDesktop,
  isHotkeyError,
  onFnChord,
  onFnTap,
  openKeyboardSettings,
  openPrivacySettings,
  relaunchApp,
  requestAccessibility,
  requestInputMonitoring,
  resetAllHotkeys,
  setHotkey,
  suspendHotkeys,
  type FnStatus,
  type HotkeyAction,
  type HotkeyBindings,
  type HotkeyConflict,
} from '@/lib/desktop/bridge';
import {
  FN,
  SHORTCUT_LABELS,
  acceleratorFromEvent,
  conflictText,
  fnChordFromEvent,
  heldCaps,
  hotkeyErrorText,
  isFnChord,
  keyCaps,
  keysText,
  mayBeFnChord,
  savedConflictText,
  type HeldModifiers,
} from './shortcut-keys';

export { SHORTCUT_LABELS, talkHint } from './shortcut-keys';

const FALLBACK_DEFAULTS: HotkeyBindings = { toggle: 'Cmd+Shift+Space', dictation: 'Cmd+Shift+D', assistant: 'Alt+Shift+Space' };
const NOTHING_HELD: HeldModifiers = { meta: false, ctrl: false, alt: false, shift: false };
/**
 * How long a key the Mac app may report as an fn chord waits for that report:
 * the webview sees fn+Space as plain Space.
 */
const FN_CHORD_GRACE_MS = 150;

/** Shared state for every ShortcutRow on a screen: the bindings, the defaults, fn readiness, and which row is recording. */
export type Shortcuts = {
  bindings: HotkeyBindings | null;
  defaults: HotkeyBindings;
  /** What else uses each saved shortcut (macOS, another app), re-checked whenever they load. */
  saved: Partial<Record<HotkeyAction, HotkeyConflict | null>>;
  fn: FnStatus | null;
  recording: HotkeyAction | null;
  /** While recording: whether the Mac app will report a lone fn tap. */
  fnArmed: boolean;
  startRecording: (action: HotkeyAction) => Promise<void>;
  stopRecording: () => Promise<void>;
  reload: () => Promise<void>;
  recheckFn: () => Promise<void>;
  /** Tell the screen something changed (e.g. so it can re-read shortcut hints). */
  changed: () => void;
};

function fnReady(fn: FnStatus | null): boolean {
  return !fn || (fn.input_monitoring && fn.globe_action === 'do_nothing');
}

/** Loads the shortcuts and keeps fn readiness fresh (re-checked whenever the panel regains focus). */
export function useShortcuts(onChanged?: () => void): Shortcuts {
  const [bindings, setBindings] = useState<HotkeyBindings | null>(null);
  const [defaults, setDefaults] = useState<HotkeyBindings>(FALLBACK_DEFAULTS);
  const [saved, setSaved] = useState<Partial<Record<HotkeyAction, HotkeyConflict | null>>>({});
  const savedCheck = useRef(0);
  const [fn, setFn] = useState<FnStatus | null>(null);
  const [recording, setRecording] = useState<HotkeyAction | null>(null);
  const [fnArmed, setFnArmed] = useState(false);
  const recordingRef = useRef<HotkeyAction | null>(null);
  const bindingsRef = useRef<HotkeyBindings | null>(null);
  const fnRef = useRef<FnStatus | null>(null);
  const changedRef = useRef(onChanged);
  useEffect(() => { changedRef.current = onChanged; }, [onChanged]);

  const reload = useCallback(async () => {
    const settings = await getSettings().catch(() => null);
    const next = settings ? { toggle: settings.toggle_hotkey ?? '', dictation: settings.dictation_hotkey ?? '', assistant: settings.assistant_hotkey ?? '' } : FALLBACK_DEFAULTS;
    bindingsRef.current = next;
    setBindings(next);
    // Shells out in the Mac app, so it never holds up the rows; only the latest check counts.
    const check = ++savedCheck.current;
    setSaved({});
    void checkAllHotkeys().then((conflicts) => { if (check === savedCheck.current) setSaved(conflicts); });
  }, []);

  const recheckFn = useCallback(async () => {
    const next = await fnStatus();
    const before = fnRef.current;
    fnRef.current = next;
    setFn(next);
    // An fn shortcut saved before Input Monitoring (fn alone) or Accessibility
    // (fn with a key) was allowed isn't listening yet; register it now that it can.
    const all = bindingsRef.current ? Object.values(bindingsRef.current) : [];
    const loneFnReady = all.includes(FN) && next?.input_monitoring && before && !before.input_monitoring;
    const chordReady = all.some(isFnChord) && next?.accessibility && before && before.accessibility === false;
    if ((loneFnReady || chordReady) && !recordingRef.current) {
      await suspendHotkeys(false).catch(() => {});
    }
  }, []);

  useEffect(() => {
    void reload();
    void getHotkeyDefaults().then((next) => { if (next?.toggle !== undefined) setDefaults(next); }).catch(() => {});
    void recheckFn();
    const onFocus = () => { void recheckFn(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void recheckFn(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      // Leaving the screen mid-recording must not leave every shortcut off.
      if (recordingRef.current) void suspendHotkeys(false).catch(() => {});
    };
  }, [reload, recheckFn]);

  const startRecording = useCallback(async (action: HotkeyAction) => {
    recordingRef.current = action;
    setRecording(action);
    setFnArmed(false);
    setFnArmed(await suspendHotkeys(true).catch(() => false));
  }, []);

  const stopRecording = useCallback(async () => {
    if (!recordingRef.current) return;
    recordingRef.current = null;
    setRecording(null);
    await suspendHotkeys(false).catch(() => {});
  }, []);

  const changed = useCallback(() => changedRef.current?.(), []);

  return { bindings, defaults, saved, fn, recording, fnArmed, startRecording, stopRecording, reload, recheckFn, changed };
}

type Notice =
  | { kind: 'error'; text: string }
  | { kind: 'conflict'; accelerator: string; conflict: HotkeyConflict }
  | { kind: 'taken'; accelerator: string; by: HotkeyAction };

/**
 * One shortcut: label · key chip (click to record) · Clear · Reset.
 * Problems show inline under the row, never in a dialog (DESIGN.md §5).
 */
export function ShortcutRow({ shortcuts, action, label = SHORTCUT_LABELS[action], hint }: {
  shortcuts: Shortcuts;
  action: HotkeyAction;
  label?: string;
  hint?: ReactNode;
}) {
  const desktop = isDesktop();
  const value = shortcuts.bindings?.[action] ?? '';
  const fallback = shortcuts.defaults[action];
  const recording = shortcuts.recording === action;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState<HeldModifiers>(NOTHING_HELD);
  // A notice is about the shortcut it was raised for; drop it once that changes
  // (a swap, reset or restore from elsewhere).
  const [noticeFor, setNoticeFor] = useState(value);
  if (noticeFor !== value) {
    setNoticeFor(value);
    setNotice(null);
  }
  const rowRef = useRef<HTMLDivElement>(null);
  // Whether the Mac app is listening while recording, so it can report fn chords.
  const fnArmedRef = useRef(shortcuts.fnArmed);
  const { reload, recheckFn, changed, startRecording, stopRecording } = shortcuts;

  const fail = useCallback((error: unknown, accelerator: string) => {
    if (isHotkeyError(error) && error.kind === 'taken' && error.by !== 'other') {
      setNotice({ kind: 'taken', accelerator, by: error.by });
    } else if (isHotkeyError(error) && error.kind === 'needsModifier' && !fnArmedRef.current && /^([A-Z0-9]|Space)$/.test(accelerator)) {
      // fn+Space arrives as plain Space when the Mac app can't hear fn.
      setNotice({ kind: 'error', text: `${hotkeyErrorText(error, accelerator)} Holding fn? Eavesy needs Input Monitoring to see it while you record.` });
    } else {
      setNotice({ kind: 'error', text: isHotkeyError(error) ? hotkeyErrorText(error, accelerator) : errMsg(error, 'Couldn’t change the shortcut.') });
    }
  }, []);

  const commit = useCallback(async (accelerator: string, swap = false) => {
    setBusy(true);
    try {
      await setHotkey(action, accelerator, swap);
      setNotice(null);
      await reload();
      if (accelerator === FN) await recheckFn();
      changed();
    } catch (error) {
      fail(error, accelerator);
    } finally {
      setBusy(false);
    }
  }, [action, reload, recheckFn, changed, fail]);

  const propose = useCallback(async (accelerator: string) => {
    setNotice(null);
    setBusy(true);
    try {
      const conflict = await checkHotkey(action, accelerator);
      if (conflict) setNotice({ kind: 'conflict', accelerator, conflict });
      else await commit(accelerator);
    } catch (error) {
      fail(error, accelerator);
    } finally {
      setBusy(false);
    }
  }, [action, commit, fail]);

  const record = useCallback(() => {
    setNotice(null);
    setHeld(NOTHING_HELD);
    void startRecording(action);
  }, [action, startRecording]);

  const cancel = useCallback(() => {
    setHeld(NOTHING_HELD);
    void stopRecording();
  }, [stopRecording]);

  // The listeners below live for one recording; keep them from re-subscribing
  // when these callbacks change identity mid-recording.
  const proposeRef = useRef(propose);
  const cancelRef = useRef(cancel);
  const stopRef = useRef(stopRecording);
  // Set while recording: takes the shortcut, once. "Use fn" goes through it too.
  const captureRef = useRef<(accelerator: string) => void>(() => {});
  useEffect(() => {
    proposeRef.current = propose;
    cancelRef.current = cancel;
    stopRef.current = stopRecording;
    fnArmedRef.current = shortcuts.fnArmed;
  }, [propose, cancel, stopRecording, shortcuts.fnArmed]);

  useEffect(() => {
    if (!recording) return;
    // One recording yields at most one shortcut, even if the webview and the
    // Mac app both report the same fn tap.
    let consumed = false;
    const capture = async (accelerator: string) => {
      if (consumed) return;
      consumed = true;
      setHeld(NOTHING_HELD);
      await stopRef.current().catch(() => {});
      await proposeRef.current(accelerator);
    };
    captureRef.current = (accelerator) => { void capture(accelerator); };
    // The webview sees fn only on some Macs; the Mac app reports a tap too
    // when Input Monitoring is on.
    let fnDown = false;
    let chorded = false;
    // fn+Space reaches the webview as plain Space; while the Mac app listens,
    // such a key waits briefly for its "Fn+Space" report before counting as itself.
    let pending: ReturnType<typeof setTimeout> | null = null;
    const settle = () => { if (pending) clearTimeout(pending); pending = null; };
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setHeld({ meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
      if (e.key === 'Fn') { fnDown = true; chorded = false; return; }
      if (e.repeat) return;
      if (fnDown) {
        chorded = true;
        // This Mac's webview reports fn itself.
        const chord = fnChordFromEvent(e);
        if (chord) { settle(); void capture(chord); return; }
      }
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { cancelRef.current(); return; }
      const accelerator = acceleratorFromEvent(e);
      if (!accelerator) return;
      settle();
      if (fnArmedRef.current && mayBeFnChord(e)) {
        pending = setTimeout(() => { pending = null; void capture(accelerator); }, FN_CHORD_GRACE_MS);
        return;
      }
      void capture(accelerator);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setHeld({ meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
      if (e.key === 'Fn') {
        if (fnDown && !chorded) void capture(FN);
        fnDown = false;
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!rowRef.current?.contains(e.target as Node)) cancelRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    const unlisten: (() => void)[] = [];
    let gone = false;
    const keep = (stop: () => void) => { if (gone) stop(); else unlisten.push(stop); };
    void onFnTap(() => { void capture(FN); }).then(keep);
    void onFnChord((accelerator) => { settle(); void capture(accelerator); }).then(keep);
    return () => {
      gone = true;
      settle();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      unlisten.forEach((stop) => stop());
      captureRef.current = () => {};
    };
  }, [recording]);

  const liveCaps = heldCaps(held);
  // Only a note about the shortcut as it is now; the Mac app re-checks after every change.
  const savedConflict = value ? shortcuts.saved[action] ?? null : null;
  // Only promise "tap fn" when the Mac app confirmed it's listening for one.
  const fnHearable = !desktop || shortcuts.fnArmed;

  return (
    <div ref={rowRef} className="ev-shortcut" data-recording={recording || undefined}>
      <div className="ev-shortcut-row">
        <div className="min-w-0 flex-1">
          <p className="ev-set-label">{label}</p>
          {hint ? <p className="ev-set-hint">{hint}</p> : null}
        </div>
        <div className="ev-shortcut-keys">
          <button
            type="button"
            className="ev-shortcut-chip"
            data-recording={recording || undefined}
            disabled={!desktop || busy}
            aria-label={recording ? `Recording a shortcut for ${label}` : `Change the ${label} shortcut (now ${value ? keysText(value) : 'not set'})`}
            onClick={() => (recording ? cancel() : record())}
          >
            {recording ? (
              <>
                <Mascot state="listening" size={16} />
                {liveCaps.length ? <Kbd keys={liveCaps} size="md" /> : <span className="ev-shortcut-prompt">Press keys…</span>}
              </>
            ) : value ? (
              <Kbd keys={keyCaps(value)} size="md" />
            ) : (
              <span className="ev-shortcut-prompt">Not set</span>
            )}
          </button>
          {/* Fixed slots keep every row's chip in the same place. */}
          <span className="ev-shortcut-slot">
            {value && !recording ? (
              <IconButton label={`Clear the ${label} shortcut`} icon={X} size={24} disabled={!desktop || busy} onClick={() => { void commit(''); }} />
            ) : null}
          </span>
          <span className="ev-shortcut-slot">
            {value !== fallback && !recording ? (
              <IconButton label={`Reset to ${keysText(fallback)}`} icon={RotateCcw} size={24} disabled={!desktop || busy} onClick={() => { void propose(fallback); }} />
            ) : null}
          </span>
        </div>
      </div>

      {recording && fnHearable ? <p className="ev-shortcut-note">Press a shortcut (fn+Space works too), or tap fn on its own. Esc to cancel.</p> : null}
      {recording && !fnHearable ? (
        <p className="ev-shortcut-note">
          Press a shortcut. Esc to cancel.{' '}
          {/* Without Input Monitoring a tap of fn can't be heard, so offer it as a choice. */}
          <button type="button" className="ev-link" onClick={() => captureRef.current(FN)}>Use fn</button>
        </p>
      ) : null}
      {!desktop ? <p className="ev-shortcut-note">Change shortcuts in the Mac app.</p> : null}

      {notice?.kind === 'error' ? <p role="alert" className="ev-shortcut-error">{notice.text}</p> : null}

      {notice?.kind === 'taken' ? (
        <InlineCard text={`Already used for ${SHORTCUT_LABELS[notice.by]}.`}>
          <Button variant="primary" size="sm" loading={busy} onClick={() => { void commit(notice.accelerator, true); }}>Swap</Button>
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => setNotice(null)}>Cancel</Button>
        </InlineCard>
      ) : null}

      {notice?.kind === 'conflict' ? (
        <InlineCard text={conflictText(notice.conflict, notice.accelerator)}>
          {notice.conflict.kind === 'system' ? (
            <Button variant="outline" size="sm" onClick={() => { void openKeyboardSettings().catch(() => {}); }}>Open Keyboard Shortcuts</Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={record}>Pick another</Button>
          )}
          <Button variant="primary" size="sm" loading={busy} onClick={() => { void commit(notice.accelerator); }}>Use anyway</Button>
        </InlineCard>
      ) : null}

      {value === FN && !recording && shortcuts.fn && !fnReady(shortcuts.fn) ? <FnSetupCard fn={shortcuts.fn} onRecheck={recheckFn} /> : null}

      {isFnChord(value) && !recording && shortcuts.fn?.accessibility === false ? (
        <div className="ev-shortcut-card" data-tone="steps">
          <p>{keysText(value)} needs Accessibility, so Eavesy can catch it before the app you’re in does.</p>
          <div className="ev-shortcut-actions">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void requestAccessibility()
                  .catch(() => false)
                  .then((granted) => (granted ? undefined : openPrivacySettings('accessibility')))
                  .catch(() => {})
                  .finally(() => { void recheckFn(); });
              }}
            >
              Open Privacy settings
            </Button>
          </div>
        </div>
      ) : null}

      {/* A saved shortcut something else also uses: stays until it's changed. */}
      {savedConflict && !notice && !recording ? (
        <div className="ev-shortcut-card">
          <p>{savedConflictText(savedConflict, value)}</p>
          <div className="ev-shortcut-actions">
            {savedConflict.kind === 'system' ? (
              <Button variant="outline" size="sm" onClick={() => { void openKeyboardSettings().catch(() => {}); }}>Open Keyboard Shortcuts</Button>
            ) : null}
            <Button variant="outline" size="sm" disabled={!desktop || busy} onClick={record}>Pick another</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InlineCard({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="ev-shortcut-card" role="alert">
      <p>{text}</p>
      <div className="ev-shortcut-actions">{children}</div>
    </div>
  );
}

const GLOBE_NOW: Record<FnStatus['globe_action'], string> = {
  do_nothing: '',
  emoji: 'Right now it opens the emoji picker.',
  input_source: 'Right now it switches the input source.',
  dictation: 'Right now it starts macOS dictation.',
  unknown: 'Otherwise macOS reacts to fn too.',
};

/** What's left before fn works: Input Monitoring, then 🌐 set to Do Nothing. Re-checked on focus. */
function FnSetupCard({ fn, onRecheck }: { fn: FnStatus; onRecheck: () => Promise<void> }) {
  const [opened, setOpened] = useState(false);
  const [relaunchError, setRelaunchError] = useState<string | null>(null);
  const globeDone = fn.globe_action === 'do_nothing';
  return (
    <div className="ev-shortcut-card" data-tone="steps">
      <p>Two things in System Settings, then fn is ready.</p>
      <ol className="ev-shortcut-steps">
        <li data-done={fn.input_monitoring || undefined}>
          <StatusDisc status={fn.input_monitoring ? 'granted' : 'pending'} />
          <div className="min-w-0 flex-1">
            <p className="ev-set-label">Allow Input Monitoring</p>
            {!fn.input_monitoring ? (
              <>
                <p className="ev-set-hint">{opened ? 'Turn on Eavesy, then relaunch so macOS applies it.' : 'So Eavesy can notice a tap of fn.'}</p>
                <div className="ev-shortcut-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setOpened(true);
                      void requestInputMonitoring()
                        .catch(() => {})
                        .then(() => openPrivacySettings('input_monitoring'))
                        .catch(() => {})
                        .finally(() => { void onRecheck(); });
                    }}
                  >
                    Open Privacy settings
                  </Button>
                  {opened ? (
                    <Button variant="primary" size="sm" onClick={() => { void relaunchApp().catch((e: unknown) => setRelaunchError(errMsg(e, 'Couldn’t relaunch Eavesy.'))); }}>
                      Relaunch Eavesy
                    </Button>
                  ) : null}
                </div>
                {relaunchError ? <p role="alert" className="ev-shortcut-error">{relaunchError}</p> : null}
              </>
            ) : null}
          </div>
        </li>
        <li data-done={globeDone || undefined}>
          <StatusDisc status={globeDone ? 'granted' : 'pending'} />
          <div className="min-w-0 flex-1">
            <p className="ev-set-label">Set “Press 🌐 key to” Do Nothing</p>
            {!globeDone ? (
              <>
                <p className="ev-set-hint">{GLOBE_NOW[fn.globe_action]}</p>
                <div className="ev-shortcut-actions">
                  <Button variant="outline" size="sm" onClick={() => { void openKeyboardSettings().catch(() => {}); }}>Open Keyboard settings</Button>
                </div>
              </>
            ) : null}
          </div>
        </li>
      </ol>
    </div>
  );
}

/** Section footer: puts both shortcuts back after a confirm. Hidden while they're already the defaults. */
export function RestoreDefaultShortcuts({ shortcuts }: { shortcuts: Shortcuts }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { bindings, defaults, reload, changed } = shortcuts;
  if (!isDesktop() || !bindings || (bindings.toggle === defaults.toggle && bindings.dictation === defaults.dictation && bindings.assistant === defaults.assistant)) return null;
  const restore = () => {
    setBusy(true);
    setError(null);
    void resetAllHotkeys()
      .then(async () => { setConfirming(false); await reload(); changed(); })
      .catch((e: unknown) => setError(isHotkeyError(e) ? hotkeyErrorText(e, '') : errMsg(e, 'Couldn’t restore the shortcuts.')))
      .finally(() => setBusy(false));
  };
  return (
    <div className="ev-shortcut-footer">
      {confirming ? (
        <>
          <p className="ev-set-hint flex-1">
            {SHORTCUT_LABELS.toggle} goes back to {keysText(defaults.toggle)}, {SHORTCUT_LABELS.dictation} to {keysText(defaults.dictation)} and {SHORTCUT_LABELS.assistant} to {keysText(defaults.assistant)}.
          </p>
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
          <Button variant="primary" size="sm" loading={busy} onClick={restore}>Restore</Button>
        </>
      ) : (
        <button type="button" className="ev-link" onClick={() => setConfirming(true)}>Restore default shortcuts</button>
      )}
      {error ? <p role="alert" className="ev-shortcut-error w-full">{error}</p> : null}
    </div>
  );
}
