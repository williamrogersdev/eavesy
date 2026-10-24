import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Clock, RotateCcw, Send, X } from 'lucide-react';
import { errMsg } from '@/lib/desktop/errors';
import { invoke, useEvent } from './marking';
import './styles.css';

document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

type Kind = 'approval' | 'question' | 'finished';

/** One waiting Claude Code session (agents/queue.rs `Item`). */
interface Item {
  id: number;
  session_id: string;
  name: string;
  kind: Kind;
  summary: string | null;
  suggestion: string | null;
  message: string | null;
  /** Its hook is waiting, so Send goes straight into the session. */
  held: boolean;
  /** A reply you dictated, read back and waiting for your “send it”. */
  draft: string | null;
  /** You clicked in to type, so voice answers leave it alone. */
  typing: boolean;
}

const preview = !(window as unknown as { __TAURI__?: unknown }).__TAURI__;
const PREVIEW: Item[] = preview ? [
  { id: 1, session_id: 'a', name: 'eavesy', kind: 'question', summary: 'wants to know whether to ship the HUD fix behind a flag', suggestion: 'No flag. Ship it and open a PR.', message: 'The HUD fix is ready and tests pass. Should I put it behind a flag or ship it directly?', held: true, draft: null, typing: false },
  { id: 2, session_id: 'b', name: 'repackify', kind: 'approval', summary: 'needs approval to run a command', suggestion: null, message: null, held: false, draft: null, typing: false },
] : [];

const KIND_LABEL: Record<Kind, string> = { approval: 'Needs approval', question: 'Asks you', finished: 'Finished' };

/**
 * The reply card: the Claude Code session at the front of the queue, what it
 * needs, and the reply Eavesy suggests. Send goes into that session through
 * its waiting hook; nothing is sent until you press it or say “send it”.
 */
function Agents() {
  const [items, setItems] = useState<Item[]>(PREVIEW);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shownId = useRef<number | null>(null);
  const shownDraft = useRef<string | null>(null);
  const head = items[0] ?? null;

  useEffect(() => { void invoke('agents_state').then((state) => { if (state) setItems((state as { items: Item[] }).items); }); }, []);
  useEvent('agents:state', (payload) => setItems((payload as { items: Item[] }).items));

  // A new session at the front starts from its own suggestion; a reply you
  // dictated replaces what's in the box.
  useEffect(() => {
    if (head?.id === shownId.current && (head?.draft ?? null) === shownDraft.current) return;
    shownId.current = head?.id ?? null;
    shownDraft.current = head?.draft ?? null;
    setDraft(head?.draft ?? head?.suggestion ?? '');
    setNote(null);
  }, [head?.id, head?.suggestion, head?.draft]);

  if (!head) return null;
  const waiting = items.length - 1;
  const canReply = head.kind !== 'approval';

  const send = () => {
    setBusy(true);
    setNote(null);
    void invoke('agents_send', { id: head.id, sessionId: head.session_id, text: draft })
      .then((how) => { if (how === 'copied') setNote('This session stopped waiting, so your reply is copied. Paste it into the session.'); })
      .catch((error: unknown) => setNote(errMsg(error, 'Couldn’t send that reply.')))
      .finally(() => setBusy(false));
  };

  return (
    <div className="ag-card" role="dialog" aria-label={`${head.name}: ${KIND_LABEL[head.kind]}`}>
      <div className="ag-head">
        <span className="ag-kind" data-kind={head.kind}>{KIND_LABEL[head.kind]}</span>
        <span className="ag-name">{head.name}</span>
        {waiting > 0 && <span className="ag-more">+{waiting} waiting</span>}
        <button type="button" className="ag-icon" title="Say it again" aria-label="Say it again" onClick={() => void invoke('agents_repeat')}><RotateCcw size={13} strokeWidth={1.75} /></button>
      </div>
      <p className="ag-summary">{head.summary}</p>
      {head.message && <p className="ag-message" title={head.message}>{head.message}</p>}
      {canReply ? (
        <textarea
          className="ag-reply"
          value={draft}
          placeholder="Your reply to Claude"
          rows={3}
          maxLength={20000}
          onFocus={() => void invoke('agents_edit', { id: head.id })}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && event.metaKey && draft.trim()) send(); }}
        />
      ) : (
        <p className="ag-note">Approve or deny it in Claude. Eavesy never approves tools for you.</p>
      )}
      {canReply && head.draft && !head.typing && !note && <p className="ag-note">Say “send it” to send this, or say something else to change it.</p>}
      {note && <p className="ag-note">{note}</p>}
      <div className="ag-actions">
        <button type="button" className="ag-btn" onClick={() => void invoke('agents_dismiss', { id: head.id })}><X size={13} strokeWidth={1.75} />{head.held ? 'Let it stop' : 'Dismiss'}</button>
        <button type="button" className="ag-btn" onClick={() => void invoke('agents_later', { id: head.id })}><Clock size={13} strokeWidth={1.75} />Later</button>
        {canReply && (
          <button type="button" className="ag-btn" data-primary disabled={busy || !draft.trim()} onClick={send} title={head.held ? 'Send to Claude (⌘↩)' : 'Copy your reply (⌘↩)'}>
            <Send size={13} strokeWidth={1.75} />{head.held ? 'Send' : 'Copy'}
          </button>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Agents /></StrictMode>);
