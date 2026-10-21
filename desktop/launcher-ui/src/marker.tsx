import { StrictMode, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Undo2 } from 'lucide-react';
import { Mascot } from '@/components/launcher/ui/mascot';
import { errMsg } from '@/lib/desktop/errors';
import { invoke, NO_MARKING, useEvent, useMarking, type MarkingState, type Rect } from './marking';
import './styles.css';

document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

interface Hover { rect: Rect; label: string | null }
interface Tagged { number: number; rect: Rect | null; key: number }

const preview = !(window as unknown as { __TAURI__?: unknown }).__TAURI__;

function previewMarking(): MarkingState {
  if (!preview) return NO_MARKING;
  const tool = new URLSearchParams(window.location.search).get('tool') === 'element' ? 'element' : 'area';
  return { sessionId: 'preview', clicks: 4, marks: [{ number: 1, rect: { x: 809, y: 394, width: 114, height: 36 } }], tool, shortcut: '⌥H' };
}

const box = (rect: Rect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });

function normalised(from: { x: number; y: number }, to: { x: number; y: number }): Rect {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}

/**
 * The marker: a see-through panel over the recorded screen. The recording
 * leaves Eavesy's windows out, so the dimming, outlines and tags here are for
 * the user only; what they tag is saved beside the video.
 */
function Marker() {
  const marking = useMarking(previewMarking());
  const [hover, setHover] = useState<Hover | null>(preview ? { rect: { x: 343, y: 347, width: 562, height: 36 }, label: 'toggle “Email notifications”' } : null);
  const [drag, setDrag] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [stamps, setStamps] = useState<Tagged[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stampKey = useRef(0);
  const stampTimers = useRef(new Set<number>());
  useEffect(() => () => stampTimers.current.forEach((timer) => window.clearTimeout(timer)), []);

  useEvent('marker:hover', (payload) => setHover(payload as Hover | null));
  useEvent('moments:tagged', (payload) => {
    const tagged = payload as Omit<Tagged, 'key'>;
    const key = ++stampKey.current;
    setStamps((current) => [...current, { ...tagged, key }]);
    const timer = window.setTimeout(() => {
      stampTimers.current.delete(timer);
      setStamps((current) => current.filter((stamp) => stamp.key !== key));
    }, 1600);
    stampTimers.current.add(timer);
  });

  useEffect(() => {
    dragStart.current = null;
    setDrag(null);
    setError(null);
    if (marking.tool !== 'element') setHover(null);
  }, [marking.tool]);

  const act = (cmd: string, args?: Record<string, unknown>) => {
    setError(null);
    void invoke(cmd, args).catch((reason: unknown) => setError(errMsg(reason, 'Couldn’t tag that')));
  };

  // Native Escape is registered globally; this also handles key events when
  // the webview owns focus or the global shortcut could not be registered.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && marking.tool) {
        event.preventDefault();
        void invoke('stop_marking').catch((reason: unknown) => setError(errMsg(reason, 'Couldn’t close the highlighter')));
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [marking.tool]);

  const at = (event: PointerEvent) => ({
    x: Math.max(0, Math.min(window.innerWidth, event.clientX)),
    y: Math.max(0, Math.min(window.innerHeight, event.clientY)),
  });
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, .mk-hint')) return;
    if (marking.tool === 'element') act('mark_element', { point: at(event) });
    else if (marking.tool === 'area') {
      dragStart.current = at(event);
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ from: dragStart.current, to: dragStart.current });
    }
  };
  const move = (event: PointerEvent) => {
    if (dragStart.current) setDrag({ from: dragStart.current, to: at(event) });
  };
  const cancel = () => { dragStart.current = null; setDrag(null); };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const from = dragStart.current;
    if (!from) return;
    // Use the release point, even if the last move hasn't rendered yet.
    const rect = normalised(from, at(event));
    cancel();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (rect.width >= 8 && rect.height >= 8) act('mark_area', { rect });
  };

  if (!marking.tool) return null;
  const dragged = drag ? normalised(drag.from, drag.to) : null;
  const focus = marking.tool === 'element' ? hover?.rect ?? null : dragged;
  // Out of the way of whatever is being pointed at near the bottom.
  const hintAtTop = !!focus && focus.y + focus.height > window.innerHeight - 150;

  return (
    <div className="launcher-scope ev mk-root" data-tool={marking.tool} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel}>
      {focus ? <div className="mk-spot" data-tool={marking.tool} style={box(focus)} /> : <div className="mk-dim" />}
      {marking.tool === 'element' && hover && (
        <div className="mk-chip" style={{ left: Math.max(8, Math.min(hover.rect.x, window.innerWidth - 340)), top: Math.max(8, hover.rect.y - 32) }}>
          {hover.label && <span>{hover.label}</span>}
          <span className="mk-chip-quiet">click to tag</span>
        </div>
      )}
      {dragged && dragged.width > 0 && (
        <div className="mk-size" style={{ left: Math.max(8, dragged.x + dragged.width - 70), top: Math.min(window.innerHeight - 28, dragged.y + dragged.height + 6) }}>
          {Math.round(dragged.width)} × {Math.round(dragged.height)}
        </div>
      )}
      {marking.marks.map((mark) => mark.rect && (
        <div key={mark.number} className="mk-tagged" style={box(mark.rect)}>
          <span className="mk-tag">{mark.number}</span>
        </div>
      ))}
      {stamps.map((stamp) => stamp.rect && (
        <span key={stamp.key} className="mk-stamp" role="status" style={{ left: stamp.rect.x + stamp.rect.width / 2, top: stamp.rect.y + stamp.rect.height / 2 }}>
          Tagged #{stamp.number}
        </span>
      ))}
      <div className="mk-hint" data-top={hintAtTop || undefined}>
        <span className="mk-mascot"><Mascot size={34} state="listening" recording /></span>
        <p className="mk-bubble">
          {marking.tool === 'element'
            ? 'Point at an element, then click to tag it. Use Area to drag a box.'
            : 'Drag a box around what matters. Your narration continues recording.'}
        </p>
        {error && <p className="mk-error" role="alert">{error}</p>}
        {marking.marks.length > 0 && (
          <button type="button" className="mk-btn" onClick={() => act('undo_mark')}><Undo2 className="h-3.5 w-3.5" />Undo tag</button>
        )}
        <button type="button" className="mk-btn" onClick={() => act('stop_marking')}>Done marking <kbd className="mk-kbd">esc</kbd></button>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <Marker />
  </StrictMode>,
);
