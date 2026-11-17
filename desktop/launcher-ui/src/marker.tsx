import { StrictMode, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Undo2 } from 'lucide-react';
import { Mascot } from '@/components/launcher/ui/mascot';
import { errMsg } from '@/lib/desktop/errors';
import { DRAG_FROM, gesture, invoke, NO_MARKING, useEvent, useMarking, type MarkingState, type Rect } from './marking';
import './styles.css';

document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

interface Hover { rect: Rect; label: string | null }
interface Tagged { number: number; rect: Rect | null; key: number }

const preview = !(window as unknown as { __TAURI__?: unknown }).__TAURI__;

/** How long "Highlight saved" shows before the highlighter puts itself away. */
const CLOSE_AFTER_MS = 450;

function previewMarking(): MarkingState {
  if (!preview) return NO_MARKING;
  return { sessionId: 'preview', clicks: 4, marks: [{ number: 1, rect: { x: 809, y: 394, width: 114, height: 36 } }], tool: 'element', shortcut: '⌥H' };
}

const box = (rect: Rect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });

function normalised(from: { x: number; y: number }, to: { x: number; y: number }): Rect {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}

/**
 * The highlighter: a see-through panel over the recorded screen. It outlines
 * what the pointer is on; a click highlights that, and a drag highlights a
 * box instead. After one highlight it puts itself away, so the next click
 * goes to the app again; ⇧ held keeps it out for several. The recording
 * leaves Eavesy's windows out, so the dimming, outlines and numbers here are
 * for the user only; what they highlight is saved beside the video.
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

  const closing = useRef<number | null>(null);
  const keepOpen = useCallback(() => {
    if (closing.current !== null) window.clearTimeout(closing.current);
    closing.current = null;
  }, []);
  useEffect(() => keepOpen, [keepOpen]);

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
    // A close still pending belongs to the highlighter as it was: reopened
    // meanwhile, it must not be put away again.
    keepOpen();
    if (!marking.tool) setHover(null);
  }, [marking.tool, keepOpen]);

  const act = (cmd: string, args?: Record<string, unknown>) => {
    setError(null);
    void invoke(cmd, args).catch((reason: unknown) => setError(errMsg(reason, 'Couldn’t do that')));
  };
  /** Saves a highlight, then closes unless more were asked for (⇧) or it failed. */
  const highlight = (cmd: 'mark_element' | 'mark_area', args: Record<string, unknown>, more: boolean) => {
    setError(null);
    keepOpen();
    void invoke(cmd, args).then(() => {
      if (more) return;
      closing.current = window.setTimeout(() => {
        closing.current = null;
        void invoke('stop_marking').catch(() => {});
      }, CLOSE_AFTER_MS);
    }, (reason: unknown) => setError(errMsg(reason, 'Couldn’t highlight that')));
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
    keepOpen();
    dragStart.current = at(event);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    const from = dragStart.current;
    if (!from) return;
    const to = at(event);
    // A box only once the pointer has really moved: a click with a shaky hand stays a click.
    if (drag || Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_FROM) setDrag({ from, to });
  };
  const cancel = () => { dragStart.current = null; setDrag(null); };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const from = dragStart.current;
    if (!from) return;
    // Use the release point, even if the last move hasn't rendered yet.
    const to = at(event);
    const what = gesture(from, to, !!drag);
    cancel();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (what === 'click') highlight('mark_element', { point: from }, event.shiftKey);
    else if (what === 'box') highlight('mark_area', { rect: normalised(from, to) }, event.shiftKey);
  };

  if (!marking.tool) return null;
  const dragged = drag ? normalised(drag.from, drag.to) : null;
  const focus = dragged ?? hover?.rect ?? null;
  // Out of the way of whatever is being pointed at near the bottom.
  const hintAtTop = !!focus && focus.y + focus.height > window.innerHeight - 150;

  return (
    <div className="launcher-scope ev mk-root" data-tool={dragged ? 'area' : 'element'} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel}>
      {focus ? <div className="mk-spot" data-tool={dragged ? 'area' : 'element'} style={box(focus)} /> : <div className="mk-dim" />}
      {!dragged && hover && (
        <div className="mk-chip" style={{ left: Math.max(8, Math.min(hover.rect.x, window.innerWidth - 340)), top: Math.max(8, hover.rect.y - 32) }}>
          {hover.label && <span>{hover.label}</span>}
          <span className="mk-chip-quiet">click to highlight</span>
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
          Highlight {stamp.number} saved
        </span>
      ))}
      <div className="mk-hint" data-top={hintAtTop || undefined}>
        <span className="mk-mascot"><Mascot size={34} state="listening" recording /></span>
        <p className="mk-bubble">
          Click what you mean, or drag a box around it. Hold <kbd className="mk-kbd">⇧</kbd> to highlight several.
        </p>
        {error && <p className="mk-error" role="alert">{error}</p>}
        {marking.marks.length > 0 && (
          <button type="button" className="mk-btn" onClick={() => act('undo_mark')}><Undo2 className="h-3.5 w-3.5" />Undo last</button>
        )}
        <button type="button" className="mk-btn" onClick={() => act('stop_marking')}>Done <kbd className="mk-kbd">esc</kbd></button>
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
