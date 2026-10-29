import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Clock, FolderGit2, RotateCcw, Send, SquareArrowOutUpRight, Volume2, X } from 'lucide-react';
import { errMsg } from '@/lib/desktop/errors';
import { invoke, useEvent } from './marking';
import './styles.css';

document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

type Kind = 'approval' | 'question' | 'finished';

/** Where a session runs (agents/queue.rs `Origin`). */
interface Origin {
  /** Its folder, with `~` for your home folder. */
  cwd: string | null;
  branch: string | null;
  /** The app it runs in, like “iTerm”: clicking the card brings it forward. */
  app: string | null;
}

/** One waiting Claude Code session, or a remote agent's message (agents/queue.rs `Item`). */
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
  /** You said no to it, so “send it” sends nothing until a new draft. */
  declined: boolean;
  origin: Origin;
}

/** The line Eavesy reads aloud for the card (agents/mod.rs `Saying`). */
interface Saying {
  token: number;
  line: string;
  covers: number[];
  /** Not said yet: Eavesy waits for this card to draw it. */
  pending: boolean;
}

interface State { items: Item[]; saying: Saying | null }

const preview = !(window as unknown as { __TAURI__?: unknown }).__TAURI__;
const NO_ORIGIN: Origin = { cwd: null, branch: null, app: null };
const PREVIEW: State = preview ? {
  items: [
    { id: 1, session_id: 'a', name: 'eavesy', kind: 'question', summary: 'wants to know whether to ship the HUD fix behind a flag', suggestion: 'No flag. Ship it and open a PR.', message: 'The HUD fix is ready and tests pass. Should I put it behind a flag or ship it directly?', held: true, draft: null, typing: false, declined: false, origin: { cwd: '~/Developer/eavesy/.claude/worktrees/fix-hud-0971e9', branch: 'claude/fix-hud-0971e9', app: 'iTerm' } },
    { id: 2, session_id: 'b', name: 'repackify', kind: 'approval', summary: 'needs approval to run a command', suggestion: null, message: null, held: false, draft: null, typing: false, declined: false, origin: { cwd: '~/Developer/repackify', branch: 'main', app: 'Ghostty' } },
    { id: 3, session_id: 'c', name: 'docs', kind: 'finished', summary: 'finished: Rewrote the setup guide.', suggestion: null, message: null, held: false, draft: null, typing: false, declined: false, origin: { cwd: '~/Developer/docs', branch: 'rewrite-setup', app: 'VS Code' } },
    { id: 4, session_id: 'd', name: 'eavesy on api keys', kind: 'finished', summary: 'finished: Merged the REST API PR.', suggestion: null, message: null, held: false, draft: null, typing: false, declined: false, origin: { cwd: '~/Developer/eavesy/.claude/worktrees/api-keys', branch: 'claude/api-keys', app: 'Claude' } },
  ],
  saying: { token: 1, line: '2 sessions need you. First, eavesy: wants to know whether to ship the HUD fix behind a flag. I’d say: No flag. Ship it and open a PR. Send that?', covers: [1], pending: false },
} : { items: [], saying: null };
// The real card floats over any app; preview it over a dark desktop so a card
// that forgot its own background shows up here too.
if (preview) document.body.style.background = new URLSearchParams(location.search).get('bg') ?? '#2b2f36';

const KIND_LABEL: Record<Kind, string> = { approval: 'Needs approval', question: 'Asks you', finished: 'Finished' };

/** “eavesy · claude/fix-hud”: the name, with the branch when the name doesn't already carry it. */
function Where({ item }: { item: Item }) {
  const { cwd, branch, app } = item.origin ?? NO_ORIGIN;
  if (!cwd && !branch && !app) return null;
  return (
    <p className="ag-where" title={[cwd, branch && `on ${branch}`, app && `in ${app}`].filter(Boolean).join(' ')}>
      <FolderGit2 size={12} strokeWidth={1.75} aria-hidden />
      {/* Cut from the left, so the end of a long path stays: “…/worktrees/fix-hud”. */}
      {cwd && <span className="ag-where-path"><bdi>{cwd}</bdi></span>}
      {branch && <span className="ag-where-branch">{branch}</span>}
      {app && <span className="ag-where-app">in {app}</span>}
    </p>
  );
}

/**
 * The reply card: the Claude Code session at the front of the queue, which
 * session it is (folder, branch, the app it runs in), what it needs, the line
 * Eavesy reads aloud, and the reply Eavesy suggests. Eavesy only speaks once
 * this card has drawn the line (`agents_rendered`). Send goes into that session
 * through its waiting hook; nothing is sent until you press it or say “send it”.
 */
function Agents() {
  const [state, setState] = useState<State>(PREVIEW);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shownId = useRef<number | null>(null);
  const shownDraft = useRef<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const { items, saying } = state;
  const head = items[0] ?? null;

  // Anything that isn't a queue snapshot is ignored rather than drawn.
  const take = (next: unknown) => {
    const candidate = next as Partial<State> | null;
    if (candidate && Array.isArray(candidate.items)) setState({ items: candidate.items, saying: candidate.saying ?? null });
  };
  useEffect(() => { void invoke('agents_state').then(take); }, []);
  useEvent('agents:state', take);

  // A new session at the front starts from its own suggestion; a reply you
  // dictated replaces what's in the box.
  useEffect(() => {
    if (head?.id === shownId.current && (head?.draft ?? null) === shownDraft.current) return;
    shownId.current = head?.id ?? null;
    shownDraft.current = head?.draft ?? null;
    setDraft(head?.draft ?? head?.suggestion ?? '');
    setNote(null);
  }, [head?.id, head?.suggestion, head?.draft]);

  // Tell Eavesy the line is on screen, and how tall the card is: it speaks
  // only after this, so nothing is ever said without the card showing.
  const token = saying?.token ?? 0;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const headId = head?.id ?? null;
  const report = () => {
    // The card's 6px margin on each side is part of the window.
    const height = Math.ceil(card.current?.getBoundingClientRect().height ?? 0) + 12;
    void invoke('agents_rendered', { token: tokenRef.current, height });
  };
  useLayoutEffect(() => {
    if (headId === null) return;
    // Two frames: the line has been painted, not just laid out.
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(report); });
    return () => cancelAnimationFrame(frame);
  }, [headId, token]);
  // The card fits the window to itself as it grows or shrinks.
  useEffect(() => {
    const node = card.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => report());
    observer.observe(node);
    return () => observer.disconnect();
  }, [headId === null]);

  if (!head) return null;
  // From send_to_human / ask_human on Eavesy's MCP (agents/remote.rs).
  const remote = head.session_id.startsWith('remote:');
  const canReply = head.kind !== 'approval' && (!remote || head.held);
  const others = items.slice(1);
  const heard = saying && saying.covers.includes(head.id) ? saying : null;
  const alsoHeard = saying && !heard && saying.covers.some((id) => others.some((item) => item.id === id)) ? saying : null;

  const send = () => {
    setBusy(true);
    setNote(null);
    const sent = remote
      ? invoke('agents_answer', { id: head.id, text: draft })
      : invoke('agents_send', { id: head.id, sessionId: head.session_id, text: draft });
    void sent
      .then((how) => { if (how === 'copied') setNote('This session stopped waiting, so your reply is copied. Paste it into the session.'); })
      .catch((error: unknown) => setNote(errMsg(error, 'Couldn’t send that reply.')))
      .finally(() => setBusy(false));
  };
  const open = (item: Item) => {
    void invoke('agents_open', { id: item.id }).catch((error: unknown) => setNote(errMsg(error, 'Couldn’t open that session.')));
  };

  return (
    <div ref={card} className="launcher-scope ev ag-card" role="dialog" aria-label={`${head.name}: ${KIND_LABEL[head.kind]}`}>
      <div className="ag-head">
        <span className="ag-kind" data-kind={head.kind}>{KIND_LABEL[head.kind]}</span>
        <span className="ag-name" title={head.name}>{head.name}</span>
        <button type="button" className="ag-icon" title="Say it again" aria-label="Say it again" onClick={() => void invoke('agents_repeat')}><RotateCcw size={13} strokeWidth={1.75} /></button>
        {head.origin?.app && (
          <button type="button" className="ag-icon" title={`Go to this session in ${head.origin.app}`} aria-label={`Go to this session in ${head.origin.app}`} onClick={() => open(head)}><SquareArrowOutUpRight size={13} strokeWidth={1.75} /></button>
        )}
      </div>
      <Where item={head} />
      <p className="ag-summary">{head.summary}</p>
      {head.message && <p className="ag-message" title={head.message}>{head.message}</p>}
      {heard && (
        <p className="ag-heard" data-pending={heard.pending || undefined}>
          <Volume2 size={12} strokeWidth={1.75} aria-label={heard.pending ? 'About to say' : 'Said'} />
          <span>“{heard.line}”</span>
        </p>
      )}
      {canReply ? (
        <textarea
          className="ag-reply"
          value={draft}
          placeholder={remote ? `Your answer to ${head.name}` : 'Your reply to Claude'}
          rows={3}
          maxLength={20000}
          onFocus={() => void invoke('agents_edit', { id: head.id })}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && event.metaKey && draft.trim()) send(); }}
        />
      ) : head.kind === 'approval' ? (
        <p className="ag-note">Approve or deny it in {head.origin?.app ?? 'Claude'}. Eavesy never approves tools for you.</p>
      ) : null}
      {remote && canReply && <p className="ag-note">Your answer goes back to {head.name} as text. It never approves anything.</p>}
      {canReply && head.draft && !head.typing && !head.declined && !note && <p className="ag-note">Say “send it” to send this, or say something else to change it.</p>}
      {note && <p className="ag-note">{note}</p>}
      <div className="ag-actions">
        <button type="button" className="ag-btn" onClick={() => void invoke('agents_dismiss', { id: head.id })}><X size={13} strokeWidth={1.75} />{head.held && !remote ? 'Let it stop' : 'Dismiss'}</button>
        {head.kind !== 'finished' && <button type="button" className="ag-btn" onClick={() => void invoke('agents_later', { id: head.id })}><Clock size={13} strokeWidth={1.75} />Later</button>}
        {canReply && (
          <button type="button" className="ag-btn" data-primary disabled={busy || !draft.trim()} onClick={send} title={remote ? `Send to ${head.name} (⌘↩)` : head.held ? 'Send to Claude (⌘↩)' : 'Copy your reply (⌘↩)'}>
            <Send size={13} strokeWidth={1.75} />{head.held || remote ? 'Send' : 'Copy'}
          </button>
        )}
      </div>
      {others.length > 0 && (
        <div className="ag-others">
          <p className="ag-others-title">{others.length === 1 ? '1 more session' : `${others.length} more sessions`}</p>
          {alsoHeard && (
            <p className="ag-heard">
              <Volume2 size={12} strokeWidth={1.75} aria-label="Said" />
              <span>“{alsoHeard.line}”</span>
            </p>
          )}
          <ul>
            {others.slice(0, 5).map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="ag-other"
                  disabled={!item.origin?.app}
                  title={[item.origin?.cwd, item.origin?.branch && `on ${item.origin.branch}`, item.origin?.app && `Click to go to it in ${item.origin.app}`].filter(Boolean).join(' ')}
                  onClick={() => open(item)}
                >
                  <span className="ag-dot" data-kind={item.kind} aria-label={KIND_LABEL[item.kind]} />
                  <span className="ag-other-name">{item.name}</span>
                  <span className="ag-other-summary">{item.summary}</span>
                  {item.origin?.app && <span className="ag-other-app">{item.origin.app}</span>}
                </button>
              </li>
            ))}
          </ul>
          {others.length > 5 && <p className="ag-note">and {others.length - 5} more</p>}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Agents /></StrictMode>);
