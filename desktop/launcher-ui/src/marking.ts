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

interface TauriGlobal {
  core?: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
  event?: { listen(event: string, handler: (e: { payload: unknown }) => void): Promise<() => void> };
}

function tauri(): TauriGlobal | null {
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
