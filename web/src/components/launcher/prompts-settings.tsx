'use client';

import { ArrowLeft, ChevronRight, MessageSquareText, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { claudeCodeCommand, DETAILS_SLOT, freeSlug, PROMPT_LIMITS, promptSlug, type SavedPrompt } from '@/lib/prompts';
import { Button, Card } from './ui';
import type { SavedPromptsState } from './use-saved-prompts';

function Status({ error }: { error: string | null }) {
  return error ? <p role="alert" className="ev-set-hint mt-2 text-[var(--ev-warn-ink)]">{error}</p> : null;
}

function usedLabel(prompt: SavedPrompt): string {
  return prompt.useCount === 0 ? 'not used yet' : prompt.useCount === 1 ? 'used once' : `used ${prompt.useCount} times`;
}

/** One prompt's page; `prompt` is null for a new one. */
function PromptPage({ prompt, state, onBack }: {
  prompt: SavedPrompt | null;
  state: SavedPromptsState;
  onBack: () => void;
}) {
  const [name, setName] = useState(prompt?.name ?? '');
  const [body, setBody] = useState(prompt?.body ?? '');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setName(prompt?.name ?? ''); setBody(prompt?.body ?? ''); }, [prompt?.id, prompt?.name, prompt?.body]);

  const changed = !prompt || name.trim() !== prompt.name || body !== prompt.body;
  const ready = name.trim() !== '' && body.trim() !== '' && changed;
  // A saved prompt keeps its slug through renames; a new one gets the next free one,
  // which is only known once the list has loaded.
  const slug = prompt ? prompt.slug : state.prompts ? freeSlug(promptSlug(name), new Set(state.prompts.map((p) => p.slug))) : null;

  const save = async () => {
    if (!ready || saving) return;
    setSaving(true);
    const saved = prompt
      ? await state.update(prompt.id, { ...(name.trim() !== prompt.name ? { name: name.trim() } : {}), ...(body !== prompt.body ? { body } : {}) })
      : await state.create({ name: name.trim(), body });
    setSaving(false);
    if (saved) onBack();
  };

  return (
    <div className="flex flex-col">
      <div className="ev-proj-crumbs">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>All prompts</Button>
        {prompt && <span className="ev-set-hint ml-auto shrink-0">{usedLabel(prompt)}</span>}
      </div>

      <Card title={prompt ? 'Prompt' : 'New prompt'}>
        <form
          className="ev-set-body flex flex-col gap-3"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }}
        >
          <div className="ev-field">
            <label htmlFor="prompt-name">Name</label>
            <input
              id="prompt-name"
              autoFocus={!prompt}
              className="ev-field-input"
              value={name}
              maxLength={PROMPT_LIMITS.name}
              placeholder="Like “Triage support tickets”"
              onChange={(e) => setName(e.target.value)}
            />
            <p className="ev-set-hint">
              Find it from the panel’s search.{slug && <> In Claude Code it’s <code>{claudeCodeCommand(slug)}</code>.</>}
            </p>
          </div>
          <div className="ev-field">
            <label htmlFor="prompt-body">Text</label>
            <textarea
              id="prompt-body"
              className="ev-field-input"
              rows={10}
              value={body}
              maxLength={PROMPT_LIMITS.body}
              placeholder="What you’d type, written the way that works best."
              onChange={(e) => setBody(e.target.value)}
            />
            <p className="ev-set-hint">
              Put <code>{DETAILS_SLOT}</code> where a word typed after the slash command should go, like <code>{claudeCodeCommand(slug ?? promptSlug(name))} billing</code>. Without it, the word goes at the end. Pasting from the panel leaves it blank.
            </p>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onBack}>Cancel</Button>
            <Button variant="primary" size="sm" type="submit" loading={saving} disabled={!ready || saving}>Save</Button>
          </div>
        </form>
        <Status error={state.error} />
      </Card>

      {prompt && (
        <div className="mt-4 flex items-center justify-end gap-2">
          {confirmDelete ? (
            <>
              <span className="ev-set-hint">This can’t be undone.</span>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button variant="outline" size="sm" icon={Trash2} onClick={() => { onBack(); void state.remove(prompt.id); }}>Delete</Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" icon={Trash2} onClick={() => setConfirmDelete(true)}>Delete prompt</Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Saved prompts: a list, and a page for each. `open` is the prompt whose page shows, or 'new'. */
export function PromptsSettings({ state, open, onOpen }: {
  state: SavedPromptsState;
  open: string | null;
  onOpen: (id: string | null) => void;
}) {
  const { prompts, error } = state;
  const current = open === 'new' ? null : prompts?.find((p) => p.id === open);
  if (open === 'new' || current) {
    return <PromptPage key={open} prompt={current ?? null} state={state} onBack={() => onOpen(null)} />;
  }

  const full = (prompts?.length ?? 0) >= PROMPT_LIMITS.count;
  return (
    <>
      <Card title="How prompts work">
        <ol className="ev-howto">
          <li><span><b>Save what you keep typing.</b> A request you make every week, written the way that works best.</span></li>
          <li><span><b>Paste it from the panel.</b> In the search, type <code>/</code> and part of its name, then press Return. It goes wherever your cursor was.</span></li>
          <li><span><b>Or run it in Claude Code.</b> With Eavesy connected over MCP, each prompt is a slash command, like <code>{claudeCodeCommand('triage')}</code>.</span></li>
        </ol>
      </Card>
      <Card title="Your prompts">
        {prompts?.length === 0 && <p className="ev-set-hint">No prompts yet.</p>}
        {prompts?.map((prompt) => (
          <div key={prompt.id} className="ev-projrow">
            <button type="button" className="ev-set-row ev-projrow-head" onClick={() => onOpen(prompt.id)}>
              <MessageSquareText className="h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="ev-set-label block truncate">{prompt.name}</span>
                <span className="ev-set-hint block truncate">/{prompt.slug} · {usedLabel(prompt)}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" aria-hidden />
            </button>
          </div>
        ))}
        <div className="ev-set-row">
          <Button variant="outline" size="sm" icon={Plus} disabled={prompts === null || full} onClick={() => onOpen('new')}>New prompt</Button>
          {full && <span className="ev-set-hint">That’s the limit of {PROMPT_LIMITS.count}. Delete one to add another.</span>}
        </div>
        <Status error={error} />
      </Card>
    </>
  );
}
