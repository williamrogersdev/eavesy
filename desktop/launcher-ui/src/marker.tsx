import { StrictMode, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
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
  const tool = new URLSearchParams(window.location.search).get('tool') === 'area' ? 'area' : 'element';
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
  const [stamps, setStamps] = useState<Tagged[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stampKey = useRef(0);

  useEvent('marker:hover', (payload) => setHover(payload as Hover | null));
  useEvent('moments:tagged', (payload) => {
    const tagged = payload as Omit<Tagged, 'key'>;
    const key = ++stampKey.current;
    setStamps((current) => [...current, { ...tagged, key }]);
    window.setTimeout(() => setStamps((current) => current.filter((stamp) => stamp.key !== key)), 1600);
  });

  useEffect(() => {
    setDrag(null);
    setError(null);
    if (marking.tool !== 'element') setHover(null);
  }, [marking.tool]);

  const act = (cmd: string, args?: Record<string, unknown>) => {
    setError(null);
    void invoke(cmd, args).catch((reason: unknown) => setError(errMsg(reason, 'Couldn’t tag that')));
  };

  const at = (event: MouseEvent) => ({ x: event.clientX, y: event.clientY });
  const down = (event: MouseEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    if (marking.tool === 'element') act('mark_element');
    else if (marking.tool === 'area') setDrag({ from: at(event), to: at(event) });
  };
  const move = (event: MouseEvent) => { if (drag) setDrag({ ...drag, to: at(event) }); };
  const up = () => {
    if (!drag) return;
    const rect = normalised(drag.from, drag.to);
    setDrag(null);
    if (rect.width >= 8 && rect.height >= 8) act('mark_area', { rect });
  };

  if (!marking.tool) return null;
  const dragged = drag ? normalised(drag.from, drag.to) : null;
  const focus = marking.tool === 'element' ? hover?.rect ?? null : dragged;
  // Out of the way of whatever is being pointed at near the bottom.
  const hintAtTop = !!focus && focus.y + focus.height > window.innerHeight - 150;

  return (
    <div className="launcher-scope ev mk-root" data-tool={marking.tool} onMouseDown={down} onMouseMove={move} onMouseUp={up}>
      {focus ? <div className="mk-spot" data-tool={marking.tool} style={box(focus)} /> : <div className="mk-dim" />}
      {marking.tool === 'element' && hover && (
        <div className="mk-chip" style={{ left: hover.rect.x, top: Math.max(8, hover.rect.y - 32) }}>
          {hover.label && <span>{hover.label}</span>}
          <span className="mk-chip-quiet">click to tag</span>
        </div>
      )}
      {dragged && dragged.width > 0 && (
        <div className="mk-size" style={{ left: dragged.x + dragged.width - 70, top: dragged.y + dragged.height + 6 }}>
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
            ? 'Point at the culprit and click. I’ll tag it and note what you say.'
            : 'Drag a box around the suspect. I’ll tag it and note what you say.'}
        </p>
        {error && <p className="mk-error" role="alert">{error}</p>}
        {marking.marks.length > 0 && (
          <button type="button" className="mk-btn" onClick={() => act('undo_mark')}><Undo2 className="h-3.5 w-3.5" />Undo tag</button>
        )}
        <kbd className="mk-kbd">esc</kbd>
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
