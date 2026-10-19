'use client';

import { Check, Loader2, Pencil, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { appButton } from '@/components/ui/app-page';
import { BRIEF_FORMATS, type BriefFormatId } from '@/lib/brief-formats';
import { isRecord } from '@/lib/json';
import { type MeetingData } from './types';
import { buildBriefMarkdown } from './format';

interface BriefTemplate {
  id: string;
  name: string;
}

export function BriefControls({
  data,
  meetingId,
  onSaved,
}: {
  data: MeetingData;
  meetingId: string;
  onSaved: () => void;
}) {
  const [templates, setTemplates] = useState<BriefTemplate[]>([]);
  const [selection, setSelection] = useState<BriefFormatId | `template:${string}`>('standard');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'save' | 'regenerate' | 'revert' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/templates', { signal: controller.signal })
      .then(async (response): Promise<unknown> => response.ok ? response.json() : null)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!isRecord(value) || !Array.isArray(value.items)) return;
        setTemplates(value.items.flatMap((item): BriefTemplate[] => {
          if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') return [];
          if (item.appliesTo !== 'meeting' && item.appliesTo !== 'both') return [];
          return [{ id: item.id, name: item.name }];
        }));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const startEditing = () => {
    setDraft(buildBriefMarkdown(data));
    setMessage(null);
    setEditing(true);
  };

  const save = async () => {
    if (!draft.trim()) return;
    setBusy('save');
    setMessage(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}/brief`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentMd: draft }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setEditing(false);
      setMessage('Edited brief saved.');
      onSaved();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not save the edited brief.');
    } finally {
      setBusy(null);
    }
  };

  const revert = async () => {
    setBusy('revert');
    setMessage(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}/brief`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setMessage('Showing the generated brief again.');
      onSaved();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not restore the generated brief.');
    } finally {
      setBusy(null);
    }
  };

  const regenerate = async () => {
    if (data.meeting.summaryOverrideMd && !confirmReplace) {
      setConfirmReplace(true);
      setMessage('Regenerating will replace your edited brief. Click again to confirm.');
      return;
    }
    setBusy('regenerate');
    setMessage(null);
    try {
      const custom = selection.startsWith('template:') ? selection.slice('template:'.length) : undefined;
      const response = await fetch(`/api/meetings/${meetingId}/regenerate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          format: custom ? 'standard' : selection,
          templateId: custom,
        }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = isRecord(result) && typeof result.message === 'string'
          ? result.message
          : `Server returned ${response.status}`;
        throw new Error(detail);
      }
      setConfirmReplace(false);
      setMessage('Brief regenerated.');
      onSaved();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not regenerate the brief.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Brief controls" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={selection}
          onChange={(event) => {
            setSelection(event.target.value as BriefFormatId | `template:${string}`);
            setConfirmReplace(false);
          }}
          aria-label="Brief format"
          className="h-8 rounded-full bg-ev-well px-3 font-round text-[13px] font-semibold text-ev-ink outline-none focus-visible:shadow-[var(--ev-focus)]"
        >
          {BRIEF_FORMATS.map((format) => <option key={format.id} value={format.id}>{format.name}</option>)}
          {templates.length ? <optgroup label="My templates">
            {templates.map((template) => <option key={template.id} value={`template:${template.id}`}>{template.name}</option>)}
          </optgroup> : null}
        </select>
        <button
          type="button"
          onClick={() => void regenerate()}
          disabled={busy !== null}
          className={appButton('ghost', 'sm')}
          title="Rewrite the brief in the selected format"
        >
          {busy === 'regenerate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {confirmReplace ? 'Confirm replace' : 'Regenerate'}
        </button>
        <button
          type="button"
          onClick={startEditing}
          disabled={busy !== null || editing}
          className={appButton('ghost', 'sm')}
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
        {data.meeting.summaryOverrideMd ? (
          <button type="button" onClick={() => void revert()} disabled={busy !== null} className={appButton('ghost', 'sm')}>
            {busy === 'revert' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Restore generated
          </button>
        ) : null}
        {message ? <p aria-live="polite" className="text-xs text-ev-ink-2">{message}</p> : null}
      </div>

      {editing ? (
        <div>
          <label htmlFor="brief-markdown" className="sr-only">Brief Markdown</label>
          <textarea
            id="brief-markdown"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={16}
            className="mt-2 w-full rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper p-3 text-sm leading-relaxed text-ev-ink outline-none focus:border-ev-slate focus:shadow-[var(--ev-focus)]"
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <button type="button" onClick={() => setEditing(false)} className={appButton('ghost', 'sm')}>Cancel</button>
            <button type="button" onClick={() => void save()} disabled={busy !== null || !draft.trim()} className={appButton('primary', 'sm')}>
              {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
