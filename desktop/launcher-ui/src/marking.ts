import { useEffect, useRef, useState } from 'react';

export interface Rect { x: number; y: number; width: number; height: number }
export type Tool = 'element' | 'area';

/** Clicks and tags in the screen recording now running (moments.rs). */
export interface MarkingState {
  sessionId: string | null;
  clicks: number;
  marks: { number: number; rect: Rect | null }[];
  tool: Tool | null;
  shortcut: string | null;
}

export const NO_MARKING: MarkingState = { sessionId: null, clicks: 0, marks: [], tool: null, shortcut: null };

/** The slice of `window.__TAURI__` the HUD and the marker use. */
export interface TauriGlobal {
  core?: { convertFileSrc?(path: string): string; invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
  event?: { listen(event: string, handler: (e: { payload: unknown }) => void): Promise<() => void> };
}

/** The Tauri bridge, or null in a plain browser (the dev previews). */
export function tauri(): TauriGlobal | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

export async function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  return tauri()?.core?.invoke(cmd, args);
}

/** Listens for `event` while mounted. */
export function useEvent(event: string, handler: (payload: unknown) => void) {
  const callback = useRef(handler);
  callback.current = handler;
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void tauri()?.event?.listen(event, (e) => callback.current(e.payload)).then((unlisten) => {
      if (disposed) unlisten(); else off = unlisten;
    });
    return () => { disposed = true; off?.(); };
  }, [event]);
}

export function useMarking(preview: MarkingState = NO_MARKING): MarkingState {
  const [state, setState] = useState<MarkingState>(preview);
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void (async () => {
      off = await tauri()?.event?.listen('moments:state', (event) => {
        if (!disposed) setState({ ...NO_MARKING, ...(event.payload as Partial<MarkingState>) });
      });
      if (disposed) { off?.(); return; }
      await invoke('marking_state');
    })().catch(() => {});
    return () => { disposed = true; off?.(); };
  }, []);
  return state;
}

export const clicksLabel = (clicks: number) => `${clicks} ${clicks === 1 ? 'click' : 'clicks'}`;

/** A press that moves less than this is a click on what is outlined; further, it is a box. */
export const DRAG_FROM = 8;

/**
 * What a press on the highlighter was: a click highlights the element under
 * it, a drag highlights the box it drew, and a drag too thin to be a box is
 * nothing. `dragging` is whether the press had already become a drag: one
 * that comes back to where it started is still a drag.
 */
export function gesture(from: { x: number; y: number }, to: { x: number; y: number }, dragging: boolean): 'click' | 'box' | null {
  if (!dragging && Math.hypot(to.x - from.x, to.y - from.y) < DRAG_FROM) return 'click';
  return Math.abs(to.x - from.x) >= DRAG_FROM && Math.abs(to.y - from.y) >= DRAG_FROM ? 'box' : null;
}
