import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CornerDownLeft, File as FileIcon, Image as ImageIcon, Link2, Search, Text } from 'lucide-react';
import { Kbd } from '@/components/launcher/ui/kbd';
import { Segmented } from '@/components/launcher/ui/segmented';
import { captureMediaUrl, errMsg, getSettings } from '@/lib/desktop/bridge';
import { clock, dayLabel, facts, groupByDay, keep, pasteLabel, step, when, type Clip, type ClipDetail, type ClipKind, type Shot, type View } from './clipboard-model';
import { invoke, tauri, useEvent } from './marking';
import './styles.css';

if (import.meta.env.DEV) {
  const { installDevMock } = await import('./dev-mock');
  installDevMock();
}

document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

/** Screenshots across the grid; the arrow keys count in these. */
const COLUMNS = 3;
const SHOT_LIMIT = 90;
const VIEWS: { value: View; label: string }[] = [{ value: 'clipboard', label: 'Clipboard' }, { value: 'screenshots', label: 'Screenshots' }];
const KIND_ICON: Record<ClipKind, typeof Text> = { text: Text, link: Link2, image: ImageIcon, file: FileIcon };

const startView = (): View => new URLSearchParams(window.location.search).get('view') === 'screenshots' ? 'screenshots' : 'clipboard';

function Thumb({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void captureMediaUrl(id).then((url) => { if (live) setSrc(url); }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  return src ? <img src={src} alt="" draggable={false} /> : <span className="ev-clip-wait" aria-hidden />;
}

/** The panel behind ⌥⇧V and ⌥⇧S (clipboard.rs): what you copied, and your screenshots. */
function ClipboardPanel() {
  const [view, setView] = useState<View>(startView);
  const [query, setQuery] = useState('');
  const [clips, setClips] = useState<Clip[]>([]);
  const [shots, setShots] = useState<Shot[]>([]);
  const [clipId, setClipId] = useState<number | null>(null);
  const [shotId, setShotId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClipDetail | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const asked = useRef(0);
  // Set when the panel opens: the next load selects the newest item.
  const fresh = useRef(true);
  const selection = useRef({ clipId, shotId, clips, shots });
  selection.current = { clipId, shotId, clips, shots };

  const load = useCallback((words: string) => {
    const turn = ++asked.current;
    const top = fresh.current;
    void Promise.all([
      invoke('clipboard_list', { query: words }) as Promise<{ items: Clip[] } | null>,
      invoke('list_recordings', { offset: 0, limit: SHOT_LIMIT, query: words, filter: 'screens' }) as Promise<{ items: { id: string; title: string; started_at_ms: number }[] } | null>,
    ]).then(([listing, history]) => {
      if (turn !== asked.current) return;
      const before = selection.current;
      const nextClips = listing?.items ?? [];
      const nextShots = (history?.items ?? []).map((row) => ({ id: row.id, title: row.title, atMs: row.started_at_ms }));
      setClips(nextClips);
      setShots(nextShots);
      setClipId(top ? nextClips[0]?.id ?? null : keep(nextClips.map((clip) => clip.id), before.clipId, before.clips.findIndex((clip) => clip.id === before.clipId)) as number | null);
      setShotId(top ? nextShots[0]?.id ?? null : keep(nextShots.map((shot) => shot.id), before.shotId, before.shots.findIndex((shot) => shot.id === before.shotId)) as string | null);
      fresh.current = false;
      setLoaded(true);
      setNotice(null);
    }).catch((error) => { if (turn === asked.current) setNotice(errMsg(error)); });
  }, []);

  useEffect(() => { load(query); }, [load, query]);
  useEffect(() => { input.current?.focus(); }, []);

  useEvent('clipboard:opened', (payload) => {
    const opened = payload as { view?: View; target?: string | null; fresh?: boolean } | null;
    if (opened?.view) setView(opened.view);
    setTarget(opened?.target ?? null);
    setNow(Date.now());
    void getSettings().then((settings) => setKeeping(settings?.clipboard_history ?? true)).catch(() => {});
    if (opened?.fresh) {
      fresh.current = true;
      body.current?.querySelectorAll('.ev-clip-scroll').forEach((pane) => { pane.scrollTop = 0; });
      if (query) setQuery(''); else load('');
    }
    input.current?.focus();
    input.current?.select();
  });
  // The shortcut again: its own view closes the panel, the other one switches to it.
  useEvent('clipboard:shortcut', (payload) => {
    if (payload === view) void invoke('hide_clipboard'); else if (payload === 'clipboard' || payload === 'screenshots') setView(payload);
  });
  useEvent('clipboard:changed', () => { setNow(Date.now()); load(query); });
  useEvent('recordings:updated', () => load(query));

  // The preview follows the selection.
  useEffect(() => {
    if (clipId === null) { setDetail(null); return; }
    let live = true;
    void (invoke('clipboard_item', { id: clipId }) as Promise<ClipDetail | null>)
      .then((item) => { if (live) setDetail(item ?? null); })
      .catch(() => { if (live) setDetail(null); });
    return () => { live = false; };
  }, [clipId]);

  useEffect(() => {
    body.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [clipId, shotId, view]);

  const chosen = view === 'clipboard' ? clipId !== null : shotId !== null;
  // `id` is the item just double-clicked; without it, the selected one.
  const use = useCallback((paste: boolean, id?: number | string) => {
    const clip = typeof id === 'number' ? id : selection.current.clipId;
    const shot = typeof id === 'string' ? id : selection.current.shotId;
    const sent = view === 'clipboard'
      ? clip === null ? null : invoke('clipboard_use', { id: clip, paste })
      : shot === null ? null : invoke('clipboard_use_capture', { id: shot, paste });
    void sent?.catch((error) => setNotice(errMsg(error)));
  }, [view]);
  const remove = useCallback(() => {
    const { clipId: clip, clips: rows } = selection.current;
    if (view !== 'clipboard' || clip === null) return;
    // The row goes at once and the selection moves to what took its place, so a second ⌘⌫ never lands on a row that is already going.
    const left = rows.filter((row) => row.id !== clip);
    const next = keep(left.map((row) => row.id), null, rows.findIndex((row) => row.id === clip)) as number | null;
    selection.current = { ...selection.current, clips: left, clipId: next };
    setClips(left);
    setClipId(next);
    void invoke('clipboard_delete', { id: clip }).catch((error) => setNotice(errMsg(error))).then(() => load(query));
  }, [view, load, query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const { clips: clipRows, shots: shotRows, clipId: clip, shotId: shot } = selection.current;
      if (event.key === 'Tab') {
        event.preventDefault();
        setView((current) => current === 'clipboard' ? 'screenshots' : 'clipboard');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (query) setQuery(''); else void invoke('hide_clipboard');
      } else if (event.key === 'Enter') {
        event.preventDefault();
        use(!event.metaKey);
      } else if (event.key === 'c' && event.metaKey && !event.shiftKey && !event.altKey) {
        // ⌘C copies the selected item, unless you selected some of your search to copy.
        const field = input.current;
        if (field && field.selectionStart !== field.selectionEnd) return;
        if (!window.getSelection()?.isCollapsed) return;
        event.preventDefault();
        use(false);
      } else if (event.key === 'Backspace' && event.metaKey) {
        // With words in the search field, ⌘⌫ is the field's own: it deletes them, never a row.
        if (query) return;
        event.preventDefault();
        remove();
      } else if (event.key.startsWith('Arrow') && !event.metaKey && !event.altKey) {
        if (view === 'clipboard') {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          const next = step(clipRows.findIndex((row) => row.id === clip), event.key, clipRows.length, 1);
          if (next >= 0) setClipId(clipRows[next].id);
        } else {
          // Sideways moves the caret while there are words to move it through.
          if (query && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
          event.preventDefault();
          const next = step(shotRows.findIndex((row) => row.id === shot), event.key, shotRows.length, COLUMNS);
          if (next >= 0) setShotId(shotRows[next].id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, query, use, remove]);

  // Clicks pick things without taking the keyboard from the search field.
  const stay = (event: React.MouseEvent) => event.preventDefault();
  const image = detail?.image ? tauri()?.core?.convertFileSrc?.(detail.image) ?? null : null;
  const searching = query.trim().length > 0;

  return (
    <div className="ev ev-clip" onMouseDown={(event) => { if (!(event.target instanceof HTMLInputElement)) { stay(event); input.current?.focus(); } }}>
      <header className="ev-clip-top">
        <Search size={16} strokeWidth={1.75} aria-hidden className="ev-clip-search-icon" />
        <input
          ref={input}
          className="ev-clip-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={view === 'clipboard' ? 'Search what you copied' : 'Search screenshots'}
          aria-label={view === 'clipboard' ? 'Search clipboard history' : 'Search screenshots'}
          spellCheck={false}
          autoComplete="off"
        />
        <Segmented value={view} onChange={(next) => { setView(next); input.current?.focus(); }} options={VIEWS} size="sm" label="View" />
      </header>

      <div className="ev-clip-body" ref={body}>
        {view === 'clipboard' ? (
          clips.length === 0 ? (
            <Empty
              title={!loaded ? '' : searching ? `Nothing you copied matches “${query.trim()}”` : keeping ? 'Nothing copied yet' : 'Clipboard history is off'}
              hint={!loaded || searching ? '' : keeping ? 'Copy something and it shows up here. It stays on this Mac.' : 'Turn it on in Settings, under General.'}
            />
          ) : (
            <>
              <div className="ev-clip-list ev-clip-scroll" role="listbox" aria-label="Clipboard history">
                {groupByDay(clips, (clip) => clip.lastMs, now).map((group) => (
                  <section key={group.label}>
                    <h2 className="ev-clip-day">{group.label}</h2>
                    {group.rows.map((clip) => {
                      const Icon = KIND_ICON[clip.kind] ?? Text;
                      return (
                        <button
                          key={clip.id}
                          type="button"
                          role="option"
                          aria-selected={clip.id === clipId}
                          tabIndex={-1}
                          className="ev-clip-row"
                          onMouseDown={stay}
                          onClick={() => setClipId(clip.id)}
                          onDoubleClick={() => { setClipId(clip.id); use(true, clip.id); }}
                        >
                          <Icon size={16} strokeWidth={1.75} aria-hidden />
                          <span className="ev-clip-row-title">{clip.title}</span>
                        </button>
                      );
                    })}
                  </section>
                ))}
              </div>
              <section className="ev-clip-preview" aria-label="Preview">
                {detail && detail.id === clipId && (
                  <>
                    <div className="ev-clip-content ev-clip-scroll" data-kind={detail.kind}>
                      {detail.kind === 'image'
                        ? image ? <img src={image} alt="Copied image" draggable={false} /> : null
                        : <pre>{detail.text}</pre>}
                    </div>
                    <dl className="ev-clip-facts">
                      {facts(detail, now).map(([label, value]) => (
                        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
                      ))}
                    </dl>
                  </>
                )}
              </section>
            </>
          )
        ) : shots.length === 0 ? (
          <Empty
            title={!loaded ? '' : searching ? `No screenshot matches “${query.trim()}”` : 'No screenshots yet'}
            hint={!loaded || searching ? '' : 'Screenshots you take on this Mac show up here.'}
          />
        ) : (
          <div className="ev-clip-grid ev-clip-scroll" role="listbox" aria-label="Screenshots">
            {shots.map((shot) => (
              <button
                key={shot.id}
                type="button"
                role="option"
                aria-selected={shot.id === shotId}
                aria-label={`${shot.title}, ${when(shot.atMs, now)}`}
                tabIndex={-1}
                className="ev-clip-shot"
                onMouseDown={stay}
                onClick={() => setShotId(shot.id)}
                onDoubleClick={() => { setShotId(shot.id); use(true, shot.id); }}
              >
                <span className="ev-clip-thumb"><Thumb id={shot.id} /></span>
                <span className="ev-clip-shot-when">{dayLabel(shot.atMs, now)} · {clock(shot.atMs)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <footer className="ev-clip-foot">
        {notice ? <span className="ev-clip-notice" role="alert">{notice}</span> : (
          <span className="ev-clip-hints">
            <span><Kbd keys={view === 'clipboard' || searching ? ['↑', '↓'] : ['←', '↑', '↓', '→']} /> Move</span>
            <span><Kbd keys={['tab']} /> {view === 'clipboard' ? 'Screenshots' : 'Clipboard'}</span>
            {view === 'clipboard' && !searching && <span><Kbd keys="⌘⌫" /> Remove</span>}
          </span>
        )}
        <span className="ev-clip-actions">
          <button type="button" className="ev-clip-act" disabled={!chosen} onMouseDown={stay} onClick={() => use(false)}>Copy <Kbd keys="⌘↵" /></button>
          <button type="button" className="ev-clip-act ev-clip-main" disabled={!chosen} onMouseDown={stay} onClick={() => use(true)}>
            {pasteLabel(target)} <CornerDownLeft size={13} strokeWidth={2} aria-hidden />
          </button>
        </span>
      </footer>
    </div>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="ev-clip-empty">
      <p className="ev-clip-empty-title">{title}</p>
      {hint && <p>{hint}</p>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><ClipboardPanel /></StrictMode>);
