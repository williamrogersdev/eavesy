'use client';

import { resizePanel } from '@/lib/desktop/bridge';
import { cn } from '@/lib/utils';

type ResizeEdge = 'left' | 'right' | 'bottom' | 'bottom-left' | 'bottom-right';

const RESIZE_EDGES: { edge: ResizeEdge; className: string }[] = [
  { edge: 'left', className: 'left-0 top-11 bottom-3 w-2 cursor-ew-resize' },
  { edge: 'right', className: 'right-0 top-11 bottom-3 w-2 cursor-ew-resize' },
  { edge: 'bottom', className: 'bottom-0 left-3 right-3 h-2 cursor-ns-resize' },
  { edge: 'bottom-left', className: 'bottom-0 left-0 h-3 w-3 cursor-nesw-resize' },
  { edge: 'bottom-right', className: 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize' },
];

export function ResizeHandles() {
  const start = (edge: ResizeEdge) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const origin = { x: e.screenX, y: e.screenY, width: window.innerWidth, height: window.innerHeight };
    let pending: { width: number; height: number } | null = null;
    let inFlight = false;
    const flush = () => {
      if (inFlight || !pending) return;
      const next = pending;
      pending = null;
      inFlight = true;
      void resizePanel(next.width, next.height)
        .catch(() => {})
        .finally(() => { inFlight = false; flush(); });
    };
    const move = (ev: PointerEvent) => {
      const dx = ev.screenX - origin.x;
      const dy = ev.screenY - origin.y;
      const widthDelta = edge.includes('right') ? dx * 2 : edge.includes('left') ? -dx * 2 : 0;
      const heightDelta = edge.startsWith('bottom') ? dy : 0;
      pending = { width: origin.width + widthDelta, height: origin.height + heightDelta };
      flush();
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  return (
    <>
      {RESIZE_EDGES.map(({ edge, className }) => (
        <div key={edge} aria-hidden="true" onPointerDown={start(edge)} className={cn('absolute z-30', className)} />
      ))}
    </>
  );
}
