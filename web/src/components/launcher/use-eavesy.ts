import { useCallback, useEffect, useState } from 'react';
import {
  clearAssistantThread,
  getAssistantRules,
  getAssistantState,
  getAssistantTaught,
  getAssistantThread,
  getSettings,
  onAssistantCards,
  onAssistantRules,
  onAssistantThread,
  onCaptureState,
  onHotkeysChanged,
  sendToAssistant,
  setAssistantMode,
  talkToAssistant,
  type AssistantMode,
  type AssistantState,
  type AssistantThread,
} from '@/lib/desktop/bridge';
import { errMsg } from '@/lib/desktop/errors';
import { keysText } from './shortcut-keys';
import type { Flash } from './types';

export type Eavesy = ReturnType<typeof useEavesy>;

/**
 * Eavesy's side of the panel (docs/plans/assistant.md B and C): the
 * conversation, the cards waiting for a click and the permission mode. Lives
 * at the panel, not in the conversation view, so a card that arrives while
 * you're looking at captures still shows in the ask bar.
 */
export function useEavesy(flash: Flash) {
  const [thread, setThread] = useState<AssistantThread>({ busy: false, turns: [] });
  const [state, setState] = useState<AssistantState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { listening, talkKeys } = useTalk();

  const reloadState = useCallback(() => {
    getAssistantState().then(setState).catch(() => undefined);
  }, []);
  // Rule changes waiting in Settings, from rules.md whoever wrote it (H4).
  const [rulesWaiting, setRulesWaiting] = useState(0);
  const reloadRules = useCallback(() => {
    getAssistantRules().then((rules) => setRulesWaiting(rules.pending.length)).catch(() => undefined);
  }, []);

  useEffect(() => {
    getAssistantThread().then(setThread).catch(() => undefined);
    reloadState();
    reloadRules();
    const unlisten = [
      onAssistantRules(reloadRules),
      onAssistantThread(setThread),
      onAssistantCards((cards) => setState((current) => (current ? { ...current, cards } : current))),
    ];
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearInterval(tick);
      for (const off of unlisten) void off.then((stop) => stop());
    };
  }, [reloadState, reloadRules]);

  // A timed mode falls back to Ask on its own; look again once it should have.
  useEffect(() => {
    if (state?.until_ms && state.until_ms <= now && state.effective !== 'ask') reloadState();
  }, [now, state?.until_ms, state?.effective, reloadState]);

  // Clear asks first when the conversation taught Eavesy notes it still keeps (H3):
  // `taught` is the count it asked about, and `clearing` covers the request after.
  const [taught, setTaught] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  /** Clear is waiting on you or running: nothing new is sent meanwhile. */
  const holding = taught !== null || clearing;
  // Notes undone from the conversation, so their line says so; a clear starts them over.
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set());

  /** Sends a message. Rejects (with the reason shown) if Eavesy couldn't take it. */
  const send = useCallback(async (text: string) => {
    if (!text.trim()) return;
    if (thread.busy) throw new Error('Eavesy is still answering.');
    if (holding) throw new Error('Finish clearing the conversation first.');
    try {
      await sendToAssistant(text);
    } catch (error) {
      flash(errMsg(error, 'Couldn’t send that'), 5000, 'warn');
      throw error;
    }
  }, [flash, holding, thread.busy]);

  const talk = useCallback(() => {
    talkToAssistant().catch((error: unknown) => flash(errMsg(error, 'Couldn’t open the mic'), 4000, 'warn'));
  }, [flash]);

  const chooseMode = useCallback((mode: AssistantMode, minutes: number | null) => {
    setAssistantMode(mode, minutes)
      .then(reloadState)
      .catch((error: unknown) => {
        if (errMsg(error, '') !== 'cancelled') flash(errMsg(error, 'Couldn’t change the mode'), 5000, 'warn');
      });
  }, [flash, reloadState]);

  const clear = useCallback((forget: boolean, instead?: string) => {
    setClearing(true);
    // The Mac forgets only if the count you were shown still holds.
    clearAssistantThread(forget, forget ? taught ?? undefined : undefined)
      .then((line) => {
        setTaught(null);
        setUndone(new Set());
        if (instead) flash(instead, 5000, 'warn');
        else if (line) flash(line, 4000);
      })
      .catch((error: unknown) => {
        flash(errMsg(error, 'Couldn’t clear it'), 4000, 'warn');
        // Ask again with what's kept now, in case the notes changed while you decided.
        if (forget) getAssistantTaught().then((notes) => setTaught(notes.length || null)).catch(() => setTaught(null));
      })
      .finally(() => setClearing(false));
  }, [flash, taught]);
  const startClear = useCallback(() => {
    getAssistantTaught()
      .then((notes) => { if (notes.length) setTaught(notes.length); else clear(false); })
      // Nothing is forgotten without asking: clear, keep every note, and say so.
      .catch(() => clear(false, 'Cleared. Eavesy couldn’t check its notes, so it kept them all; Settings shows them.'));
  }, [clear]);
  const cancelClear = useCallback(() => setTaught(null), []);
  const markUndone = useCallback((note: string) => setUndone((current) => new Set(current).add(note)), []);

  return {
    thread,
    state,
    now,
    rulesWaiting,
    reloadState,
    send,
    talk,
    listening,
    talkKeys,
    chooseMode,
    taught,
    clearing,
    holding,
    startClear,
    clear,
    cancelClear,
    undone,
    markUndone,
    /** Cards waiting for your click. */
    waiting: state?.cards.length ?? 0,
  };
}

/** Whether a recording for Eavesy is open, and the Talk to Eavesy shortcut as key caps. */
function useTalk(): { listening: boolean; talkKeys: string } {
  const [listening, setListening] = useState(false);
  const [talkKeys, setTalkKeys] = useState('');
  useEffect(() => {
    let disposed = false;
    const loadKeys = () => void getSettings().then((settings) => {
      if (!disposed) setTalkKeys(settings?.assistant_hotkey ? keysText(settings.assistant_hotkey) : '');
    }, () => {});
    loadKeys();
    const offState = onCaptureState((status) => setListening(status.mode === 'assistant' && status.phase === 'recording'));
    const offKeys = onHotkeysChanged(loadKeys);
    return () => {
      disposed = true;
      void offState.then((off) => off());
      void offKeys.then((off) => off());
    };
  }, []);
  return { listening, talkKeys };
}
