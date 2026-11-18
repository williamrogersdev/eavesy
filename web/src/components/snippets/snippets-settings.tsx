import '../dictionary/dictionary.css';
import './snippets.css';

import { Check, Pencil, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, IconButton, Select } from '@/components/launcher/ui';
import { isDesktop, snippetsRequest } from '@/lib/desktop/bridge';
import { MAX_SNIPPET_TEXT, MAX_TRIGGER, SNIPPET_FIELDS, fieldLabel, snippetProblem } from '@/lib/snippets';

type Snippet = { id: string; trigger: string; text: string; field: string | null };
type Draft = { trigger: string; text: string; field: string };

const NO_FIELD = 'none';
const FIELD_OPTIONS = [{ value: NO_FIELD, label: 'No form field' }, ...SNIPPET_FIELDS.map((field) => ({ value: field.key, label: `Fills ${field.label.toLowerCase()}` }))];
const EMPTY: Draft = { trigger: '', text: '', field: NO_FIELD };

function SnippetForm({ draft, onChange, onSubmit, onCancel, busy, submitLabel, autoFocus }: {
  draft: Draft;
  onChange: (next: Draft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  busy: boolean;
  submitLabel: string;
  autoFocus?: boolean;
}) {
  return (
    <form
      className="ev-snip-form"
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      onKeyDown={(e) => { if (e.key === 'Escape' && onCancel) { e.stopPropagation(); onCancel(); } }}
    >
      <input
        autoFocus={autoFocus}
        aria-label="When you say"
        placeholder="When you say, like “my email”"
        className="ev-field-input"
        value={draft.trigger}
        maxLength={MAX_TRIGGER}
        disabled={busy}
        onChange={(e) => onChange({ ...draft, trigger: e.target.value })}
      />
      <textarea
        aria-label="Type this"
        placeholder="Type this, like “you@example.com”"
        className="ev-field-input"
        rows={2}
        value={draft.text}
        maxLength={MAX_SNIPPET_TEXT}
        disabled={busy}
        onChange={(e) => onChange({ ...draft, text: e.target.value })}
      />
      <div className="ev-snip-form-foot">
        <Select label="Form field it fills" value={draft.field} options={FIELD_OPTIONS} disabled={busy} onChange={(field) => onChange({ ...draft, field })} />
        <span className="ev-dict-actions">
          {onCancel && <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
          <Button variant="primary" size="sm" type="submit" icon={submitLabel === 'Add' ? Plus : Check} loading={busy} disabled={busy || !draft.trigger.trim() || !draft.text.trim()}>{submitLabel}</Button>
        </span>
      </div>
    </form>
  );
}

/**
 * Voice snippets: say a phrase in a dictation and Eavesy types saved text in
 * its place. One tagged with a form field is also what Fill field pastes.
 */
export function SnippetsSettings() {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const result = await snippetsRequest<{ snippets: Snippet[] }>('GET');
    setSnippets(result.snippets);
    setLoaded(true);
  }, []);
  const reload = useCallback(async () => {
    setError('');
    try { await load(); } catch { setError('Your snippets couldn’t be loaded. Check your connection to eavesy.com and try again.'); }
  }, [load]);
  useEffect(() => { void reload(); }, [reload]);

  const run = async (change: () => Promise<string>): Promise<boolean> => {
    setBusy(true); setError(''); setNotice('');
    try {
      setNotice(await change());
      await load().catch(() => setError('That was saved, but the list couldn’t be refreshed.'));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t update your snippets.');
      return false;
    } finally { setBusy(false); }
  };

  const save = (next: Draft, id?: string) => {
    const problem = snippetProblem(next.trigger, next.text);
    if (problem) { setError(problem); setNotice(''); return Promise.resolve(false); }
    return run(async () => {
      await snippetsRequest('PUT', { id, trigger: next.trigger, text: next.text, field: next.field === NO_FIELD ? null : next.field });
      return id ? 'Saved.' : 'Added.';
    });
  };
  const add = () => void save(draft).then((ok) => { if (ok) setDraft(EMPTY); });
  const remove = (snippet: Snippet) => void run(async () => {
    await snippetsRequest('DELETE', { id: snippet.id });
    return `Removed “${snippet.trigger}”.`;
  });

  return (
    <Card title="Snippets">
      <div className="ev-set-body flex flex-col gap-3">
        <p className="ev-set-hint">
          Say the phrase while you dictate and Eavesy types the text instead. Pick a phrase you wouldn’t say otherwise.
          {isDesktop() ? ' Tag one with a form field and the Fill field shortcut pastes it into fields that ask for it.' : ' Tag one with a form field and the Mac app’s Fill field shortcut pastes it into fields that ask for it.'}
        </p>
        <SnippetForm draft={draft} onChange={setDraft} onSubmit={add} busy={busy || !loaded} submitLabel="Add" />
        {notice && <p role="status" className="ev-set-hint">{notice}</p>}
        {error && <div role="alert" className="ev-settings-feedback"><p>{error}</p>{!loaded && <Button size="sm" variant="outline" disabled={busy} onClick={() => void reload()}>Retry</Button>}</div>}
        {snippets.length > 0 && (
          <ul className="ev-dict-list">
            {snippets.map((snippet) => editing?.id === snippet.id ? (
              <li key={snippet.id} className="ev-dict-row" data-editing>
                <SnippetForm
                  autoFocus
                  draft={editing.draft}
                  onChange={(next) => setEditing({ id: snippet.id, draft: next })}
                  onSubmit={() => void save(editing.draft, snippet.id).then((ok) => { if (ok) setEditing(null); })}
                  onCancel={() => setEditing(null)}
                  busy={busy}
                  submitLabel="Save"
                />
              </li>
            ) : (
              <li key={snippet.id} className="ev-dict-row">
                <button
                  type="button"
                  className="ev-snip-view"
                  disabled={busy}
                  aria-label={`Edit ${snippet.trigger}`}
                  onClick={() => setEditing({ id: snippet.id, draft: { trigger: snippet.trigger, text: snippet.text, field: snippet.field ?? NO_FIELD } })}
                >
                  <span className="ev-dict-to">“{snippet.trigger}”{snippet.field && <span className="ev-dict-tag">fills {fieldLabel(snippet.field)?.toLowerCase()}</span>}</span>
                  <span className="ev-snip-text">{snippet.text}</span>
                </button>
                <span className="ev-dict-actions">
                  <IconButton label={`Edit ${snippet.trigger}`} icon={Pencil} disabled={busy} onClick={() => setEditing({ id: snippet.id, draft: { trigger: snippet.trigger, text: snippet.text, field: snippet.field ?? NO_FIELD } })} />
                  <IconButton label={`Remove ${snippet.trigger}`} icon={X} disabled={busy} onClick={() => remove(snippet)} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {loaded && !snippets.length && !error && <p className="ev-set-hint">No snippets yet. Your email, address or a booking link are good first ones.</p>}
      </div>
    </Card>
  );
}
