import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, EyeOff, ShieldAlert, Volume2 } from 'lucide-react';
import {
  clearAssistantThread,
  decideAssistantCard,
  forgetAssistantNote,
  getAssistantRules,
  getAssistantState,
  getAssistantThread,
  onAssistantCards,
  onAssistantRules,
  onAssistantThread,
  openSettingsWindow,
  repeatAssistantReply,
  sendToAssistant,
  setAssistantMode,
  setAssistantOffRecord,
  type AssistantBook,
  type AssistantCard,
  type AssistantMode,
  type AssistantState,
  type AssistantThread,
} from '@/lib/desktop/bridge';
import { errMsg } from '@/lib/desktop/errors';
import { Bubble, Button, IconButton, Mascot, Menu } from './ui';
import { acceptLabel, modeIsLoud, modeLabel, rulesWaitingLine, toolLabel } from './eavesy-model';

type Flash = (text: string, ms?: number, tone?: 'warn') => void;

/**
 * The Eavesy tab (docs/plans/assistant.md B and C): the conversation, the cards
 * waiting for a click, and the permission mode. Everything Eavesy says is shown
 * as plain text, never as HTML.
 */
export function EavesyTab({ flash }: { flash: Flash }) {
  const [thread, setThread] = useState<AssistantThread>({ busy: false, turns: [] });
  const [state, setState] = useState<AssistantState | null>(null);
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  // Notes undone from this tab, so their line says so.
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set());
  const undo = (note: string, book: AssistantBook = 'setup') => {
    forgetAssistantNote(note, book)
      .then(() => setUndone((current) => new Set(current).add(note)))
      .catch((error: unknown) => flash(errMsg(error, 'Couldn’t undo that'), 4000, 'warn'));
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  const turnCount = thread.turns.length;
  const cardCount = state?.cards.length ?? 0;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turnCount, cardCount, thread.busy]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || thread.busy) return;
    setDraft('');
    sendToAssistant(text).catch((error: unknown) => {
      setDraft((current) => current || text);
      flash(errMsg(error, 'Couldn’t send that'), 5000, 'warn');
    });
  }, [draft, flash, thread.busy]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const chooseMode = useCallback((mode: AssistantMode, minutes: number | null) => {
    setAssistantMode(mode, minutes)
      .then(reloadState)
      .catch((error: unknown) => {
        if (errMsg(error, '') !== 'cancelled') flash(errMsg(error, 'Couldn’t change the mode'), 5000, 'warn');
      });
  }, [flash, reloadState]);

  const offRecord = thread.off_record === true;
  const toggleOffRecord = () => {
    setAssistantOffRecord(!offRecord).catch((error: unknown) => flash(errMsg(error, 'Couldn’t change that'), 5000, 'warn'));
  };

  const effective = state?.effective ?? 'ask';
  const loud = modeIsLoud(effective);

  return (
    <div className="ev-eavesy">
      <div className="ev-eavesy-head">
        <Menu
          align="start"
          trigger={(
            <button type="button" className="ev-mode" data-loud={loud} aria-label={`Permission mode: ${state ? modeLabel(state, now) : 'Ask'}`}>
              {loud && <ShieldAlert size={13} strokeWidth={1.75} aria-hidden />}
              {state ? modeLabel(state, now) : 'Ask'}
            </button>
          )}
          items={[
            { label: 'Ask: confirm sends and changes', onSelect: () => chooseMode('ask', null) },
            { label: 'Auto: run safe ones, ask the rest', onSelect: () => chooseMode('auto', null) },
            'separator',
            { label: 'Bypass for an hour', tone: 'warn', onSelect: () => chooseMode('bypass', 60) },
            { label: 'Bypass until I turn it off', tone: 'warn', onSelect: () => chooseMode('bypass', null) },
          ]}
        />
        <span className="ev-eavesy-spacer" />
        {/* Once you've said something off the record, only Clear ends it. */}
        {(!offRecord || turnCount === 0) && (
          <Button variant="quiet" size="sm" aria-pressed={offRecord} onClick={toggleOffRecord}>
            <EyeOff size={13} strokeWidth={1.75} aria-hidden /> {offRecord ? 'On the Record' : 'Off the Record'}
          </Button>
        )}
        {turnCount > 0 && (
          <Button variant="quiet" size="sm" disabled={thread.busy} onClick={() => void clearAssistantThread().catch((error: unknown) => flash(errMsg(error, 'Couldn’t clear it'), 4000, 'warn'))}>
            Clear
          </Button>
        )}
      </div>
      {offRecord && (
        <div role="status" className="ev-banner" data-tone="quiet">
          <span>Off the record: Eavesy doesn’t read or keep notes in this conversation. Clear it to go back on the record.</span>
        </div>
      )}
      {state?.tampered && (
        <div role="alert" className="ev-banner">
          <span>Your rules changed outside Eavesy, so it’s on Ask. Choose a mode to confirm.</span>
        </div>
      )}
      <div className="ev-eavesy-scroll" ref={scrollRef}>
        {turnCount === 0 && cardCount === 0 && (
          <div className="ev-eavesy-empty">
            <Mascot state="idle" />
            <Bubble tail="left">Ask me what your agents are up to, or what they left lying around on this Mac.</Bubble>
          </div>
        )}
        <ol className="ev-turns" aria-live="polite">
          {thread.turns.map((turn) => (
            <li key={turn.id} className="ev-turn" data-who={turn.who}>
              {turn.who === 'eavesy' && <span className="ev-turn-name">Eavesy</span>}
              {turn.steps.map((step, i) => (
                <span key={`${step.tool}-${i}`} className="ev-turn-step" data-ok={step.ok}>
                  {step.remembered && undone.has(step.remembered)
                    ? `Forgot: ${step.remembered}`
                    : <>{toolLabel(step.tool)}{step.line ? ` · ${step.line}` : '…'}</>}
                  {step.remembered && !undone.has(step.remembered) && (
                    <> · <button type="button" className="ev-link" onClick={() => undo(step.remembered ?? '', step.book)}>Undo</button></>
                  )}
                </span>
              ))}
              {turn.text && <p className="ev-turn-text">{turn.text}</p>}
              <span className="ev-turn-meta">
                {turn.who === 'you' ? (turn.spoken ? 'Said' : 'Typed') : turn.spoken ? 'Spoken' : null}
                {turn.who === 'eavesy' && turn.text && (
                  <button type="button" className="ev-link" aria-label="Say it again" onClick={() => void repeatAssistantReply(turn.id).catch((error: unknown) => flash(errMsg(error, 'Couldn’t say it'), 4000, 'warn'))}>
                    <Volume2 size={12} strokeWidth={1.75} aria-hidden /> Repeat
                  </button>
                )}
                {turn.who === 'eavesy' && turn.text && (
                  <button type="button" className="ev-link" onClick={() => void navigator.clipboard.writeText(turn.text).then(() => flash('Copied', 1500), () => flash('Couldn’t copy that', 4000, 'warn'))}>Copy</button>
                )}
              </span>
            </li>
          ))}
          {thread.busy && (
            <li className="ev-turn" data-who="eavesy">
              <span className="ev-turn-name">Eavesy</span>
              <span className="ev-turn-thinking" aria-label="Eavesy is thinking"><i /><i /><i /></span>
            </li>
          )}
        </ol>
        {rulesWaitingLine(rulesWaiting) && (
          <p className="ev-turn-step ev-rules-waiting">
            {rulesWaitingLine(rulesWaiting)} · <button type="button" className="ev-link" onClick={() => void openSettingsWindow('assistant')}>Review in Settings</button>
          </p>
        )}
        {state?.cards.map((card) => (
          <ActionCard key={card.id} card={card} flash={flash} onDone={reloadState} />
        ))}
      </div>
      <div className="ev-eavesy-compose">
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          placeholder="Ask Eavesy…"
          aria-label="Message Eavesy"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <IconButton icon={ArrowUp} label="Send" disabled={!draft.trim() || thread.busy} onClick={send} />
      </div>
    </div>
  );
}

/** A card: exactly what will happen, row by row. Only these buttons run it (C1, C2). */
function ActionCard({ card, flash, onDone }: { card: AssistantCard; flash: Flash; onDone: () => void }) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(card.rows.map((row) => row.id)));
  const [busy, setBusy] = useState(false);

  const decide = (accepted: string[]) => {
    setBusy(true);
    decideAssistantCard(card.id, accepted)
      .then((ran) => { if (ran) flash(ran.summary, 4000); })
      .catch((error: unknown) => flash(errMsg(error, 'Couldn’t do that'), 5000, 'warn'))
      .finally(() => { setBusy(false); onDone(); });
  };

  const toggle = (id: string) => setTicked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <section className="ev-action" aria-label={card.title}>
      {card.requester !== 'You' && <span className="ev-action-who">{card.requester} is asking</span>}
      <h4 className="ev-action-title">{card.title}</h4>
      {card.warning && <p className="ev-action-warn">{card.warning}</p>}
      {card.rows.length > 0 && (
        <div className="ev-action-rows">
          {card.rows.map((row) => (
            <label key={row.id} className="ev-action-row">
              <input type="checkbox" checked={ticked.has(row.id)} disabled={busy} onChange={() => toggle(row.id)} />
              <span>{row.label}</span>
            </label>
          ))}
        </div>
      )}
      <div className="ev-action-buttons">
        <Button variant="quiet" size="sm" disabled={busy} onClick={() => decide([])}>Don’t</Button>
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={card.rows.length > 0 && ticked.size === 0}
          onClick={() => decide(card.rows.filter((row) => ticked.has(row.id)).map((row) => row.id))}
        >
          {acceptLabel(card, ticked)}
        </Button>
      </div>
    </section>
  );
}
