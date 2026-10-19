'use client';

import { createResource } from './shared-resource';

export interface MeSummary {
  email?: string;
  displayName?: string;
  hasMac: boolean;
  /** The language notes are written in and transcripts translate to; null keeps the meeting's own. */
  notesLanguage: string | null;
}

function parseMe(value: unknown): MeSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    email: typeof record.email === 'string' ? record.email : undefined,
    displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
    hasMac: record.hasMac === true,
    notesLanguage: typeof record.notesLanguage === 'string' ? record.notesLanguage : null,
  };
}

const me = createResource('/api/me', parseMe);

export function useMe() {
  return me.use();
}

export function refreshMe() {
  return me.refresh();
}
