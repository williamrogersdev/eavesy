'use client';

import { Loader2, Pencil } from 'lucide-react';
import { useState } from 'react';
import { refreshLibrary } from '@/lib/api/use-library';

export function EditableTitle({
  meetingId,
  initial,
  onSaved,
}: {
  meetingId: string;
  initial: string;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editing = draft !== null;

  async function commit() {
    const title = (draft ?? '').trim();
    setDraft(null);
    if (!title || title === initial) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      refreshLibrary();
      onSaved();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Could not rename meeting');
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') setDraft(null);
        }}
        className="w-full rounded-[var(--ev-r-ctl)] bg-ev-paper px-2 py-0.5 font-round text-2xl font-extrabold text-ev-ink shadow-[var(--ev-focus)] outline-none"
      />
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setDraft(initial)}
        className="group flex max-w-full items-start gap-2 text-left"
        title="Rename"
      >
        <h1 className="min-w-0 break-words font-round text-2xl font-extrabold leading-tight text-ev-ink">{initial}</h1>
        {saving ? (
          <Loader2 className="mt-1.5 h-4 w-4 animate-spin text-ev-ink-3" />
        ) : (
          <Pencil className="h-4 w-4 mt-1.5 text-ev-ink-3 opacity-0 transition group-hover:opacity-100" />
        )}
      </button>
      {saveError ? <p className="mt-1 text-xs text-ev-warn-ink">{saveError}</p> : null}
    </div>
  );
}
