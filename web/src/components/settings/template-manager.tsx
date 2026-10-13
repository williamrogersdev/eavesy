'use client';

import { Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AppSection, appButton } from '@/components/ui/app-page';
import { isRecord } from '@/lib/json';
import { cn } from '@/lib/utils';

interface Template {
  id: string;
  name: string;
  description?: string | null;
  systemPrompt: string;
  appliesTo: 'meeting' | 'both';
}

export function TemplateManager() {
  const [items, setItems] = useState<Template[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/templates', { signal });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.items)) throw new Error('Invalid template response');
    setItems(body.items.flatMap(parseTemplate));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setMessage('Could not load your templates.');
    });
    return () => controller.abort();
  }, [load]);

  const reset = () => {
    setFormOpen(false);
    setEditingId(null);
    setName('');
    setDescription('');
    setPrompt('');
  };

  const edit = (template: Template) => {
    setFormOpen(true);
    setEditingId(template.id);
    setName(template.name);
    setDescription(template.description ?? '');
    setPrompt(template.systemPrompt);
    setMessage(null);
  };

  const save = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/templates', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(editingId
          ? { id: editingId, name: name.trim(), description: description.trim() || null, systemPrompt: prompt.trim() }
          : { name: name.trim(), description: description.trim() || undefined, systemPrompt: prompt.trim(), appliesTo: 'meeting' }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      await load();
      reset();
      setMessage(editingId ? 'Template updated.' : 'Template created.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not save the template.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (deletingId !== id) {
      setDeletingId(id);
      setMessage('Click Delete again to confirm.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/templates?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setItems((current) => current.filter((item) => item.id !== id));
      if (editingId === id) reset();
      setDeletingId(null);
      setMessage('Template deleted.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not delete the template.');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-accent/60';
  return (
    <AppSection
      title="Brief templates"
      description="Reusable instructions for Regenerate on any recording. Coding, research, customer and meeting formats are built in."
      action={formOpen ? null : (
        <button type="button" onClick={() => { reset(); setFormOpen(true); setMessage(null); }} className={appButton('secondary', 'sm')}>
          <Plus className="h-3.5 w-3.5" /> New
        </button>
      )}
    >
      {items.length ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {items.map((template) => (
            <li key={template.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{template.name}</p>
                <p className="truncate text-xs text-muted-foreground">{template.description || template.systemPrompt}</p>
              </div>
              <div className="flex shrink-0 gap-0.5">
                <button type="button" onClick={() => edit(template)} aria-label={`Edit ${template.name}`} className={appButton('ghost', 'sm')}>
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void remove(template.id)}
                  disabled={busy}
                  aria-label={deletingId === template.id ? `Confirm deleting ${template.name}` : `Delete ${template.name}`}
                  className={cn(appButton('ghost', 'sm'), 'text-danger hover:text-danger')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {deletingId === template.id ? 'Confirm' : null}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {formOpen ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">{editingId ? 'Edit template' : 'New template'}</p>
            <button type="button" onClick={reset} aria-label="Close template editor" className={appButton('ghost', 'sm')}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Name" aria-label="Template name" className={cn(field, 'h-9')} />
          <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="When to use it (optional)" aria-label="Template description" className={cn(field, 'h-9')} />
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={8000} rows={5} placeholder="The sections, emphasis and constraints to follow. The transcript is added automatically." aria-label="Template instructions" className={cn(field, 'py-2 leading-relaxed')} />
          <div className="flex justify-end">
            <button type="button" onClick={() => void save()} disabled={busy || !name.trim() || !prompt.trim()} className={appButton('primary', 'sm')}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {editingId ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      ) : null}
      {message ? <p aria-live="polite" className="text-xs text-muted-foreground">{message}</p> : null}
    </AppSection>
  );
}

function parseTemplate(value: unknown): Template[] {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.systemPrompt !== 'string'
    || (value.appliesTo !== 'meeting' && value.appliesTo !== 'both')
  ) {
    return [];
  }
  return [{
    id: value.id,
    name: value.name,
    description: typeof value.description === 'string' ? value.description : null,
    systemPrompt: value.systemPrompt,
    appliesTo: value.appliesTo,
  }];
}
