'use client';

import { ArrowLeft, ChevronRight, MessageSquarePlus, MessageSquareText, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { STARTER_PROMPTS, type PromptSuggestion } from '@/lib/prompt-starters';
import { claudeCodeCommand, DETAILS_SLOT, freeSlug, PROMPT_LIMITS, promptSlug, type SavedPrompt } from '@/lib/prompts';
import { flaggedLabel, ItemFeedbackCard, PromptFeedbackCard } from './prompt-feedback';
import { Button, Card } from './ui';
import { useAgentFeedback, type AgentFeedbackState } from './use-agent-feedback';
import { usePromptSuggestions, type SavedPromptsState } from './use-saved-prompts';

function Status({ error }: { error: string | null }) {
  return error ? <p role="alert" className="ev-set-hint mt-2 text-[var(--ev-warn-ink)]">{error}</p> : null;
}

function usedLabel(prompt: SavedPrompt): string {
  return prompt.useCount === 0 ? 'not used yet' : prompt.useCount === 1 ? 'used once' : `used ${prompt.useCount} times`;
}

/** One prompt's page; `prompt` is null for a new one, which can start from `initial`. */
function PromptPage({ prompt, initial, state, feedback, onBack }: {
  prompt: SavedPrompt | null;
  initial?: PromptSuggestion | null;
  state: SavedPromptsState;
  feedback: AgentFeedbackState;
  onBack: () => void;
}) {
  const [name, setName] = useState(prompt?.name ?? initial?.name ?? '');
  const [body, setBody] = useState(prompt?.body ?? initial?.body ?? '');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A saved prompt follows edits landing from elsewhere; a new one keeps what's typed.
  const savedName = prompt?.name;
  const savedBody = prompt?.body;
  useEffect(() => {
    if (savedName !== undefined) setName(savedName);
    if (savedBody !== undefined) setBody(savedBody);
  }, [prompt?.id, savedName, savedBody]);

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
        <PromptFeedbackCard
          prompt={prompt}
          items={feedback.items.filter((item) => item.targetType === 'prompt' && item.targetId === prompt.id)}
          feedback={feedback}
          state={state}
        />
      )}

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

/** Starters stop being offered once someone has a handful of their own. */
const STARTERS_UNTIL = 5;
const MAX_SHOWN = 6;

export type ShownSuggestion = PromptSuggestion & { personal: boolean };

/** What to offer: suggestions from their dictations first, then starters, none already saved by that name. */
export function shownSuggestions(saved: SavedPrompt[], personal: PromptSuggestion[] | null): ShownSuggestion[] {
  const taken = new Set(saved.map((p) => p.name.trim().toLowerCase()));
  const pool: ShownSuggestion[] = [
    ...(personal ?? []).map((s) => ({ ...s, personal: true })),
    ...(saved.length < STARTERS_UNTIL ? STARTER_PROMPTS.map((s) => ({ ...s, personal: false })) : []),
  ];
  const out: ShownSuggestion[] = [];
  for (const item of pool) {
    const key = item.name.trim().toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(item);
  }
  return out.slice(0, MAX_SHOWN);
}

function SuggestionRow({ suggestion, busy, disabled, onAdd, onEdit }: {
  suggestion: ShownSuggestion;
  busy: boolean;
  disabled: boolean;
  onAdd: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="ev-projrow">
      <div className="ev-set-row ev-prompt-suggestion">
        <MessageSquarePlus className="h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="ev-set-label block truncate">{suggestion.name}</span>
          <span className="ev-set-hint ev-prompt-why">{suggestion.why || suggestion.body}</span>
        </span>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onEdit}>Edit first</Button>
        <Button variant="outline" size="sm" icon={Plus} loading={busy} disabled={disabled} onClick={onAdd} aria-label={`Add “${suggestion.name}”`}>Add</Button>
      </div>
    </div>
  );
}

/**
 * Saved prompts: a list, and a page for each. `open` is the prompt whose page
 * shows, or 'new'. `active`: the page is on screen, so suggestions from the
 * user's dictations may be asked for.
 */
export function PromptsSettings({ state, open, onOpen, onOpenConnections, active = false }: {
  state: SavedPromptsState;
  open: string | null;
  onOpen: (id: string | null) => void;
  /** Goes to Settings → Connections, where Claude Code is connected. */
  onOpenConnections?: () => void;
  active?: boolean;
}) {
  const { prompts, error } = state;
  const suggestions = usePromptSuggestions(active && prompts !== null);
  const feedback = useAgentFeedback(active && prompts !== null);
  // A suggestion opened to edit before it's saved.
  const [draft, setDraft] = useState<PromptSuggestion | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  useEffect(() => { if (open !== 'new') setDraft(null); }, [open]);

  const current = open === 'new' ? null : prompts?.find((p) => p.id === open);
  if (open === 'new' || current) {
    return <PromptPage key={open} prompt={current ?? null} initial={draft} state={state} feedback={feedback} onBack={() => onOpen(null)} />;
  }

  const full = (prompts?.length ?? 0) >= PROMPT_LIMITS.count;
  const offered = prompts && !full ? shownSuggestions(prompts, suggestions.personal) : [];
  const personal = offered.filter((s) => s.personal);
  const starters = offered.filter((s) => !s.personal);
  const rows = (list: ShownSuggestion[]) => list.map((suggestion) => (
    <SuggestionRow
      key={suggestion.name}
      suggestion={suggestion}
      busy={adding === suggestion.name}
      disabled={adding !== null}
      onAdd={() => void add(suggestion)}
      onEdit={() => { setDraft(suggestion); onOpen('new'); }}
    />
  ));
  const add = async (suggestion: PromptSuggestion) => {
    setAdding(suggestion.name);
    setAdded(null);
    const saved = await state.create({ name: suggestion.name, body: suggestion.body });
    setAdding(null);
    if (saved) setAdded(saved.name);
  };
  const connected = onOpenConnections ? <button type="button" className="ev-link" onClick={onOpenConnections}>connected</button> : 'connected';

  return (
    <>
      <Card title="Your prompts">
        <p className="ev-set-hint">Type <code>/</code> in the panel to paste one, or run it as a slash command in Claude Code once Eavesy is {connected}.</p>
        {prompts === null && !error && <p className="ev-set-hint ev-set-body">Loading your prompts…</p>}
        {prompts?.length === 0 && (
          <div className="ev-set-body">
            <p className="ev-set-label">No prompts yet</p>
            <p className="ev-set-hint">Add one of the prompts below in one click, or write your own.</p>
          </div>
        )}
        {prompts?.map((prompt) => {
          const flagged = feedback.items.filter((item) => item.targetType === 'prompt' && item.targetId === prompt.id);
          return (
          <div key={prompt.id} className="ev-projrow">
            <button type="button" className="ev-set-row ev-projrow-head" onClick={() => onOpen(prompt.id)}>
              <MessageSquareText className="h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="ev-set-label block truncate">{prompt.name}</span>
                <span className="ev-set-hint block truncate">/{prompt.slug} · {usedLabel(prompt)}</span>
              </span>
              {flagged.length > 0 && <span className="ev-flag-count">{flaggedLabel(flagged)}</span>}
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" aria-hidden />
            </button>
          </div>
          );
        })}
        <div className="ev-set-row">
          <Button variant="outline" size="sm" icon={Plus} disabled={prompts === null || full} onClick={() => { setDraft(null); onOpen('new'); }}>New prompt</Button>
          {full && <span className="ev-set-hint">That’s the limit of {PROMPT_LIMITS.count}. Delete one to add another.</span>}
          {added && !full && <span role="status" className="ev-set-hint">Added “{added}”. Type <code>/</code> in the panel to use it.</span>}
        </div>
        <Status error={error} />
      </Card>

      {(personal.length > 0 || (suggestions.loading && !full)) && (
        <Card title="From your dictations">
          {suggestions.loading
            ? <p className="ev-set-hint">Looking through your recent dictations for things you ask for often…</p>
            : <p className="ev-set-hint">Things you’ve asked for more than once, written up as prompts.</p>}
          {rows(personal)}
        </Card>
      )}
      {starters.length > 0 && <Card title="Starter prompts">{rows(starters)}</Card>}
      <ItemFeedbackCard items={feedback.items.filter((item) => item.targetType !== 'prompt')} feedback={feedback} />
    </>
  );
}
