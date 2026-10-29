import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, EyeOff, Paperclip, ShieldAlert, Volume2 } from 'lucide-react';
import {
  decideAssistantCard,
  dontRememberTurn,
  forgetAssistantNote,
  openSettingsWindow,
  repeatAssistantReply,
  setAssistantOffRecord,
  type AssistantBook,
  type AssistantCard,
} from '@/lib/desktop/bridge';
import { errMsg } from '@/lib/desktop/errors';
import { Bubble, Button, Mascot, Menu } from './ui';
import { acceptLabel, modeIsLoud, modeLabel, rulesWaitingLine, splitAsk, toolLabel } from './eavesy-model';
import type { Eavesy } from './use-eavesy';
import type { Flash } from './types';

/**
 * The conversation with Eavesy, opened in place over the captures
 * (docs/plans/assistant.md B and C): the thread, the cards waiting for a click
 * and the permission mode. You type in the panel's one ask bar below it.
 * Everything Eavesy says is shown as plain text, never as HTML.
 */
export function EavesyConversation({ eavesy, flash, onBack }: { eavesy: Eavesy; flash: Flash; onBack: () => void }) {
  const { thread, state, now, rulesWaiting, taught, clearing, holding, undone } = eavesy;
  const scrollRef = useRef<HTMLDivElement>(null);
  const undo = (note: string, book: AssistantBook = 'setup') => {
    forgetAssistantNote(note, book)
      .then(() => eavesy.markUndone(note))
      .catch((error: unknown) => flash(errMsg(error, 'Couldn’t undo that'), 4000, 'warn'));
  };

  const turnCount = thread.turns.length;
  const cardCount = state?.cards.length ?? 0;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turnCount, cardCount, thread.busy]);

  const dontRemember = (id: number) => {
    dontRememberTurn(id)
      .then((line) => flash(line, 4000))
      .catch((error: unknown) => flash(errMsg(error, 'Couldn’t do that'), 4000, 'warn'));
  };

  const offRecord = thread.off_record === true;
  const toggleOffRecord = () => {
    setAssistantOffRecord(!offRecord).catch((error: unknown) => flash(errMsg(error, 'Couldn’t change that'), 5000, 'warn'));
  };

  const effective = state?.effective ?? 'ask';
  const loud = modeIsLoud(effective);

  return (
    <div className="ev-eavesy">
      <div className="ev-eavesy-head">
        <Button variant="ghost" size="sm" icon={ChevronLeft} className="ev-eavesy-back" title="Back to captures (esc)" onClick={onBack}>
          Captures
        </Button>
        <span className="ev-eavesy-spacer" />
        <Menu
          align="end"
          trigger={(
            <button type="button" className="ev-mode" data-loud={loud} aria-label={`Permission mode: ${state ? modeLabel(state, now) : 'Ask'}`}>
              {loud && <ShieldAlert size={13} strokeWidth={1.75} aria-hidden />}
              {state ? modeLabel(state, now) : 'Ask'}
            </button>
          )}
          items={[
            { label: 'Ask: confirm sends and changes', onSelect: () => eavesy.chooseMode('ask', null) },
            { label: 'Auto: run safe ones, ask the rest', onSelect: () => eavesy.chooseMode('auto', null) },
            'separator',
            { label: 'Bypass for an hour', tone: 'warn', onSelect: () => eavesy.chooseMode('bypass', 60) },
            { label: 'Bypass until I turn it off', tone: 'warn', onSelect: () => eavesy.chooseMode('bypass', null) },
          ]}
        />
        {/* Once you've said something off the record, only Clear ends it. */}
        {(!offRecord || turnCount === 0) && (
          <Button variant="quiet" size="sm" aria-pressed={offRecord} title={offRecord ? 'Go back on the record' : 'Eavesy won’t read or keep notes in this conversation'} onClick={toggleOffRecord}>
            <EyeOff size={13} strokeWidth={1.75} aria-hidden /> {offRecord ? 'On the record' : 'Off the record'}
          </Button>
        )}
        {turnCount > 0 && (
          <Button variant="quiet" size="sm" disabled={thread.busy || holding} onClick={eavesy.startClear}>
            Clear
          </Button>
        )}
      </div>
      {taught !== null && (
        <div role="alertdialog" aria-label="Clear the conversation" className="ev-banner ev-clear-ask" data-tone="quiet">
          <span>{taught === 1 ? 'Eavesy kept a note from this conversation.' : `Eavesy kept ${taught} notes from this conversation.`} Forget {taught === 1 ? 'it' : 'them'} too?</span>
          <span className="ev-clear-actions">
            <Button variant="primary" size="sm" disabled={clearing} onClick={() => eavesy.clear(true)}>Clear and forget</Button>
            <Button variant="outline" size="sm" disabled={clearing} onClick={() => eavesy.clear(false)}>Keep {taught === 1 ? 'it' : 'them'}</Button>
            <Button variant="quiet" size="sm" disabled={clearing} onClick={eavesy.cancelClear}>Cancel</Button>
          </span>
        </div>
      )}
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
            <Bubble tail="left">
              Ask me about anything you’ve captured, what your agents are up to, or to remember something for next time.
              {eavesy.talkKeys ? ` Type below, or press ${eavesy.talkKeys} anywhere and just talk.` : ' Type below, or press the mic and talk.'}
            </Bubble>
          </div>
        )}
        <ol className="ev-turns" aria-live="polite">
          {thread.turns.map((turn) => {
            const { question, about } = turn.who === 'you' ? splitAsk(turn.text) : { question: turn.text, about: [] };
            return (
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
                {question && <p className="ev-turn-text">{question}</p>}
                {about.length > 0 && (
                  <span className="ev-turn-about" title="Their words went with this question">
                    <Paperclip size={12} strokeWidth={1.75} aria-hidden />
                    {about.join(', ')}
                  </span>
                )}
                <span className="ev-turn-meta">
                  {turn.who === 'you' ? (turn.spoken ? 'Said' : 'Typed') : turn.spoken ? 'Spoken' : null}
                  {turn.who === 'you' && turn.unremembered && <span>Not remembered</span>}
                  {turn.who === 'you' && !turn.unremembered && !offRecord && (
                    <button type="button" className="ev-link" disabled={thread.busy || holding} onClick={() => dontRemember(turn.id)}>Don’t remember</button>
                  )}
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
            );
          })}
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
          <ActionCard key={card.id} card={card} flash={flash} onDone={eavesy.reloadState} />
        ))}
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
