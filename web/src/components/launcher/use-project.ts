'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseProject, type ProjectSummary } from '@/lib/api/projects';
import { frontWindow, listDesktopProjects, onLauncherOpened, setProjectChoice, type FrontWindow } from '@/lib/desktop/bridge';
import { matchProject } from '@/lib/projects';

/** `auto` follows the app in front; `none` records without a project; anything else is a pinned project id. */
export type ProjectMode = 'auto' | 'none' | { pinned: string };

const STORAGE_KEY = 'eavesy.launcher.project';
/** The window title is read after the launcher opens; ask again once it has had time. */
const TITLE_RETRY_MS = 400;

export function readMode(raw: string | null): ProjectMode {
  if (raw === 'none') return 'none';
  if (raw?.startsWith('pin:') && raw.length > 4) return { pinned: raw.slice(4) };
  return 'auto';
}

export function writeMode(mode: ProjectMode): string {
  return typeof mode === 'string' ? mode : `pin:${mode.pinned}`;
}

function storedMode(): ProjectMode {
  try {
    return readMode(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

export interface ProjectChoice {
  projects: ProjectSummary[];
  mode: ProjectMode;
  /** The project the next recording goes into. */
  active: ProjectSummary | null;
  /** The project the front window points at, whatever the mode. */
  detected: ProjectSummary | null;
  front: FrontWindow | null;
  setMode: (mode: ProjectMode) => void;
  /** Fetch the projects again after one was made or changed here. */
  reload: () => void;
}

export function resolveProject(
  projects: ProjectSummary[],
  mode: ProjectMode,
  detected: ProjectSummary | null,
): ProjectSummary | null {
  if (mode === 'none') return null;
  if (mode === 'auto') return detected;
  return projects.find((project) => project.id === mode.pinned) ?? detected;
}

/**
 * What the native side files hotkey recordings by. Signed out (or no projects)
 * it is an empty list, so a stale choice never outlives the account.
 */
export function projectChoicePayload(enabled: boolean, mode: ProjectMode, projects: ProjectSummary[]) {
  return {
    follow: mode === 'auto',
    pinned: enabled && typeof mode === 'object' ? mode.pinned : null,
    projects: enabled
      ? projects.map((project) => ({ id: project.id, terms: project.match.length > 0 ? project.match : [project.name] }))
      : [],
  };
}

/** Which project a recording started from the launcher belongs to. Desktop only. */
export function useProject(enabled: boolean): ProjectChoice {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [front, setFront] = useState<FrontWindow | null>(null);
  const [mode, setModeState] = useState<ProjectMode>(() => (typeof window === 'undefined' ? 'auto' : storedMode()));

  const refresh = useCallback(async () => {
    const [items, seen] = await Promise.all([
      listDesktopProjects().catch(() => null),
      frontWindow().catch(() => null),
    ]);
    if (items) setProjects(items.flatMap((item) => parseProject(item) ?? []));
    setFront(seen);
    return seen;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let retry: number | undefined;
    const run = () => {
      window.clearTimeout(retry);
      void refresh().then((seen) => {
        if (seen && !seen.title) {
          retry = window.setTimeout(() => void frontWindow().then(setFront).catch(() => undefined), TITLE_RETRY_MS);
        }
      });
    };
    run();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onLauncherOpened(run).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      unlisten?.();
    };
  }, [enabled, refresh]);

  const setMode = useCallback((next: ProjectMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, writeMode(next));
    } catch {
      // Private storage: the choice lasts until the launcher reloads.
    }
  }, []);

  // Signed out: forget the account's projects, so nothing records into one of them.
  useEffect(() => {
    if (enabled) return;
    setProjects((current) => (current.length ? [] : current));
    setFront(null);
  }, [enabled]);

  // Always tell the native side, an empty list included, and once more on sign-out.
  const wasEnabled = useRef(false);
  useEffect(() => {
    if (!enabled && !wasEnabled.current) return;
    wasEnabled.current = enabled;
    void setProjectChoice(projectChoicePayload(enabled, mode, projects)).catch(() => undefined);
  }, [enabled, mode, projects]);

  const detected = useMemo(() => matchProject(projects, front), [projects, front]);
  const active = useMemo(() => resolveProject(projects, mode, detected), [projects, mode, detected]);
  const reload = useCallback(() => { void refresh(); }, [refresh]);
  return { projects, mode, active, detected, front, setMode, reload };
}
