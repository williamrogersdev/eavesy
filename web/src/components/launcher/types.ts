import { type ReactNode } from 'react';
import type { Recording } from '@/lib/launcher/types';

export interface Command {
  kind: 'command';
  id: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  keywords: string;
  run: () => void | Promise<void>;
}
export interface RecordingRow {
  kind: 'recording';
  id: string;
  rec: Recording;
}
export type Item = Command | RecordingRow;

export interface Action {
  id: string;
  label: string;
  icon: ReactNode;
  hint?: string;
  destructive?: boolean;
  run: () => void | Promise<void>;
}

export type LauncherView = 'setup' | 'list' | 'context' | 'settings';
export type RunTask = (task: () => void | Promise<void>, fallback?: string) => void;
export type Flash = (msg: string, ms?: number, tone?: 'info' | 'warn') => void;
export type BeginRecording = (
  mode: 'audio' | 'screen',
  opts?: {
    source?: 'mixed' | 'system' | 'mic';
    mic?: boolean;
    contextBlurb?: string;
    dictation?: boolean;
  },
) => Promise<void>;
