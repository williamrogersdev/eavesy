'use client';

import { Check, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { applyAgentFeedback, mergeAgentFeedback, PromptChanged } from '@/lib/api/agent-feedback';
import { distinctAgents, FEEDBACK_KIND_LABELS, type AgentFeedback } from '@/lib/agent-feedback';
import { errMsg } from '@/lib/desktop/bridge';
import { relativeTime } from '@/lib/drops/client';
import type { SavedPrompt } from '@/lib/prompts';
import { wordDiff } from '@/lib/text-diff';
import { Button, Card } from './ui';
import type { AgentFeedbackState } from './use-agent-feedback';
import type { SavedPromptsState } from './use-saved-prompts';

export function flaggedLabel(items: readonly AgentFeedback[]): string {
  const agents = distinctAgents(items);
  return agents === 1 ? '1 agent flagged this' : `${agents} agents flagged this`;
}

/** Whether a report was made against an earlier version of the prompt than the one saved now. */
function olderThan(item: AgentFeedback, prompt: SavedPrompt): boolean {
  return item.targetVersion !== null && item.targetVersion < prompt.updatedAt;
}

/** A rewrite shown against the text it was made from, before anything is written. */
interface Preview { body: string; basedOn: string; ids: string[]; summary: string | null; older: boolean }

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <div className="ev-diff" aria-label="Changes">
      {wordDiff(before, after).map((part, i) =>
        part.type === 'add' ? <ins key={i}>{part.text}</ins>
          : part.type === 'del' ? <del key={i}>{part.text}</del>
            : <span key={i}>{part.text}</span>)}
    </div>
  );
}

/** One agent's report: what it is, who sent it, the words and why. Agent text is only ever shown as text. */
function Report({ item, prompt }: { item: AgentFeedback; prompt?: SavedPrompt }) {
  const older = prompt && olderThan(item, prompt);
  return (
    <span className="min-w-0 flex-1">
      <span className="ev-set-hint block">
        <span className="ev-flag" data-kind={item.kind}>{FEEDBACK_KIND_LABELS[item.kind]}</span>
        {' '}{item.source} · {relativeTime(item.createdAt)}{older && ' · about an older version'}
      </span>
      {item.excerpt && <q className="ev-set-label block ev-feedback-quote">{item.excerpt}</q>}
      <span className="ev-set-hint block ev-feedback-text">{item.explanation}</span>
    </span>
  );
}

/**
 * On a saved prompt's page: what agents said about it. Every change goes
 * through a preview of the new text against the current one, and is written
 * only if the prompt hasn't changed since.
 */
export function PromptFeedbackCard({ prompt, dirty, items, feedback, state }: {
  prompt: SavedPrompt;
  /** The prompt's form has unsaved edits, which applying would replace. */
  dirty: boolean;
  items: AgentFeedback[];
  feedback: AgentFeedbackState;
  state: SavedPromptsState;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [merging, setMerging] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  if (!items.length && !preview) {
    return applied ? <p role="status" className="ev-set-hint mt-4">Applied. Agents get the new text from now on.</p> : null;
  }

  const merge = async () => {
    setMerging(true);
    setError(null);
    try {
      const result = await mergeAgentFeedback(prompt.id, items.map((item) => item.id));
      const merged = items.filter((item) => result.ids.includes(item.id));
      setPreview({ body: result.body, basedOn: result.basedOn, ids: result.ids, summary: result.summary || null, older: merged.some((item) => olderThan(item, prompt)) });
    } catch (e) { setError(errMsg(e, 'Couldn’t write a rewrite right now.')); }
    setMerging(false);
  };

  const apply = async () => {
    if (!preview) return;
    setApplying(true);
    setError(null);
    try {
      const saved = await applyAgentFeedback({ promptId: prompt.id, expectedBody: preview.basedOn, body: preview.body, ids: preview.ids });
      state.replace(saved);
      feedback.drop(preview.ids);
      setPreview(null);
      setApplied(true);
    } catch (e) {
      if (e instanceof PromptChanged) {
        if (e.prompt) state.replace(e.prompt); else state.reload();
        setPreview(null);
      }
      setError(errMsg(e, 'Couldn’t apply it.'));
    }
    setApplying(false);
  };

  if (preview) {
    const unchanged = preview.body === preview.basedOn;
    return (
      <Card title="Preview">
        <div className="ev-set-body flex flex-col gap-2">
          {preview.summary && <p className="ev-set-hint">{preview.summary}</p>}
          {preview.older && (
            <p className="ev-set-hint text-[var(--ev-warn-ink)]">
              This was written for an older version of the prompt, so it may undo changes you made since. Check the struck-through words.
            </p>
          )}
          <p className="ev-set-hint">Added words are underlined, removed ones struck through. Nothing changes until you apply it.</p>
          <Diff before={preview.basedOn} after={preview.body} />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>Cancel</Button>
            {dirty && <span className="ev-set-hint">Save or cancel your edits first.</span>}
            <Button variant="primary" size="sm" icon={Check} loading={applying} disabled={applying || unchanged || dirty} onClick={() => void apply()}>
              {unchanged ? 'No changes' : 'Apply'}
            </Button>
          </div>
          {error && <p role="alert" className="ev-set-hint text-[var(--ev-warn-ink)]">{error}</p>}
        </div>
      </Card>
    );
  }

  return (
    <Card title={flaggedLabel(items)}>
      <p className="ev-set-hint">Agents that ran this prompt say it could be clearer. Look at a rewrite before you apply it: agents write these, not you.</p>
      {items.map((item) => (
        <div key={item.id} className="ev-set-row ev-feedback-row">
          <Report item={item} prompt={prompt} />
          <span className="flex shrink-0 gap-1">
            {item.suggestedRewrite && (
              <Button variant="outline" size="sm" onClick={() => setPreview({
                body: item.suggestedRewrite!,
                basedOn: prompt.body,
                ids: [item.id],
                summary: null,
                older: olderThan(item, prompt),
              })}>
                Preview
              </Button>
            )}
            <Button variant="ghost" size="sm" icon={X} onClick={() => void feedback.dismiss([item.id])} aria-label={`Dismiss ${item.source}’s report`}>Dismiss</Button>
          </span>
        </div>
      ))}
      <div className="ev-set-row">
        <Button variant="outline" size="sm" icon={Sparkles} loading={merging} disabled={merging} onClick={() => void merge()}>
          {items.length > 1 ? 'Combine into one rewrite' : 'Write a rewrite'}
        </Button>
        {items.length > 1 && <Button variant="ghost" size="sm" onClick={() => void feedback.dismiss(items.map((item) => item.id))}>Dismiss all</Button>}
      </div>
      {(error ?? feedback.error) && <p role="alert" className="ev-set-hint ev-set-body text-[var(--ev-warn-ink)]">{error ?? feedback.error}</p>}
    </Card>
  );
}

/** Typos and confusing passages agents found in recordings, dictations, notes and captures. */
export function ItemFeedbackCard({ items, feedback }: { items: AgentFeedback[]; feedback: AgentFeedbackState }) {
  if (!items.length) return null;
  return (
    <Card title="Reports on your library">
      <p className="ev-set-hint">Typos and passages that didn’t make sense to an agent, so you can fix them where they are.</p>
      {items.map((item) => (
        <div key={item.id} className="ev-set-row ev-feedback-row">
          <span className="min-w-0 flex-1">
            <span className="ev-set-label block truncate">{item.targetLabel}</span>
            <Report item={item} />
            {item.suggestedRewrite && <span className="ev-set-hint block">Suggested: <span className="ev-feedback-text">{item.suggestedRewrite}</span></span>}
          </span>
          <Button variant="ghost" size="sm" icon={X} onClick={() => void feedback.dismiss([item.id])} aria-label={`Dismiss the report on ${item.targetLabel}`}>Dismiss</Button>
        </div>
      ))}
      {feedback.error && <p role="alert" className="ev-set-hint ev-set-body text-[var(--ev-warn-ink)]">{feedback.error}</p>}
    </Card>
  );
}
