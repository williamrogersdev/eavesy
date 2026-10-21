import './dictionary.css';

import { ArrowRight, Check, ListPlus, Pencil, Plus, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, IconButton } from '@/components/launcher/ui';
import { dictionaryRequest } from '@/lib/desktop/bridge';
import { MAX_BULK_REPLACEMENTS, parseReplacements } from '@/lib/dictionary/bulk';
import { normalizeTerm } from '@/lib/dictionary/learning';

type Entry = { id: string; from: string; to: string };
type SaveResult = { learned?: number; skipped?: number; status?: string; message?: string };

/** A list this long gets a filter box. */
const FILTER_FROM = 8;

function saved(result: SaveResult): boolean {
  return result.status === 'saved' || result.status === 'unchanged' || (result.status === undefined && (result.learned ?? 0) > 0);
}

function EntryRow({ entry, busy, onSave, onRemove }: {
  entry: Entry;
  busy: boolean;
  onSave: (from: string, to: string) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [from, setFrom] = useState(entry.from);
  const [to, setTo] = useState(entry.to);
  const start = () => { setFrom(entry.from); setTo(entry.to); setEditing(true); };
  const submit = () => { void onSave(from.trim(), to.trim()).then((ok) => { if (ok) setEditing(false); }); };

  if (editing) {
    return (
      <li className="ev-dict-row" data-editing>
        <form className="ev-dict-pair" onSubmit={(e) => { e.preventDefault(); submit(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } }}>
          <input autoFocus aria-label="Heard as" className="ev-field-input" value={from} maxLength={128} onChange={(e) => setFrom(e.target.value)} />
          <ArrowRight size={14} className="ev-dict-arrow" aria-hidden />
          <input aria-label="Type instead" className="ev-field-input" value={to} maxLength={128} onChange={(e) => setTo(e.target.value)} />
          <span className="ev-dict-actions">
            <Button variant="primary" size="sm" type="submit" icon={Check} loading={busy} disabled={busy || !from.trim() || !to.trim()}>Save</Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
          </span>
        </form>
      </li>
    );
  }
  return (
    <li className="ev-dict-row">
      <button type="button" className="ev-dict-pair ev-dict-view" disabled={busy} onClick={start} aria-label={`Edit ${entry.from} → ${entry.to}`}>
        <span className="ev-dict-from">{entry.from}</span>
        <ArrowRight size={14} className="ev-dict-arrow" aria-hidden />
        <span className="ev-dict-to">{entry.to}</span>
      </button>
      <span className="ev-dict-actions">
        <IconButton label={`Edit ${entry.from}`} icon={Pencil} disabled={busy} onClick={start} />
        <IconButton label={`Remove ${entry.from} → ${entry.to}`} icon={X} disabled={busy} onClick={onRemove} />
      </span>
    </li>
  );
}

/**
 * Replacements: when Eavesy hears one thing, it types another. Add one, paste many,
 * edit or remove them in place. Fixes made to a transcript land here too.
 */
export function DictionarySettings() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [bulk, setBulk] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ text: string; undo?: Entry } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => { const result = await dictionaryRequest<{ entries: Entry[] }>('GET'); setEntries(result.entries); setLoaded(true); }, []);
  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try { await load(); }
    catch { setError('Your dictionary couldn’t be loaded. Check your connection to eavesy.com and try again.'); }
    finally { setLoading(false); }
  }, [load]);
  useEffect(() => { void reload(); }, [reload]);

  /** Runs one change, then shows the list as the server now has it. */
  const run = async (change: () => Promise<string>, undo?: Entry): Promise<boolean> => {
    setBusy(true); setError(''); setNotice(null);
    try {
      const text = await change();
      setNotice({ text, undo });
      try { await load(); }
      catch { setError('That was saved, but the list couldn’t be refreshed. Try again to see it.'); }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t update your dictionary.');
      return false;
    } finally { setBusy(false); }
  };

  const put = async (pair: { from: string; to: string }) => {
    const result = await dictionaryRequest<SaveResult>('PUT', pair);
    if (!saved(result)) throw new Error(result.message ?? 'That replacement couldn’t be saved. Check that both sides are words and differ.');
    return result;
  };

  const add = () => run(async () => {
    const result = await put({ from: from.trim(), to: to.trim() });
    setFrom(''); setTo('');
    return result.status === 'unchanged' ? 'That one is already in your dictionary.' : 'Added.';
  });

  const edit = (entry: Entry, next: { from: string; to: string }) => run(async () => {
    if (next.from === entry.from && next.to === entry.to) return 'No changes.';
    await put(next);
    // A new "heard as" is a new entry, so the old one goes.
    if (normalizeTerm(next.from) !== normalizeTerm(entry.from)) {
      try { await dictionaryRequest('DELETE', { id: entry.id }); }
      catch { throw new Error(`Saved “${next.from} → ${next.to}”, but couldn’t remove “${entry.from}”. Remove it from the list.`); }
    }
    return 'Saved.';
  });

  const remove = (entry: Entry) => void run(async () => {
    await dictionaryRequest('DELETE', { id: entry.id });
    return `Removed “${entry.from} → ${entry.to}”.`;
  }, entry);

  /** Puts a removed entry back, unless something else now uses its "heard as". */
  const undoRemove = async (back: Entry) => {
    const current = (await dictionaryRequest<{ entries: Entry[] }>('GET')).entries;
    const taken = current.find((entry) => normalizeTerm(entry.from) === normalizeTerm(back.from));
    if (taken) throw new Error(`“${taken.from}” is already set to “${taken.to}”, so the old one wasn’t put back.`);
    await put(back);
  };

  const parsed = useMemo(() => parseReplacements(bulk ?? ''), [bulk]);
  const addMany = () => void run(async () => {
    const result = await dictionaryRequest<SaveResult>('PUT', { entries: parsed.entries });
    const learned = result.learned ?? 0;
    const skipped = (result.skipped ?? 0) + parsed.unread.length;
    if (result.status === 'unchanged') { setBulk(null); return 'All of these are already in your dictionary.'; }
    if (!learned) throw new Error('None of these could be added. Each side needs a word or short phrase, the two must differ, and your dictionary holds up to 500.');
    setBulk(null);
    const added = learned === 1 ? 'Added 1 replacement.' : `Added ${learned} replacements.`;
    return skipped ? `${added} ${skipped === 1 ? '1 line was' : `${skipped} lines were`} skipped: each side needs a word or short phrase, and they must differ.` : added;
  });

  const query = normalizeTerm(filter);
  const shown = query ? entries.filter((entry) => normalizeTerm(`${entry.from} ${entry.to}`).includes(query)) : entries;
  const disabled = !loaded || busy;

  return (
    <Card title="Replacements">
      <div className="ev-set-body flex flex-col gap-3">
        <p className="ev-set-hint">
          When Eavesy hears the word on the left, it types the one on the right. When you fix a word in a transcript, Eavesy adds it here too.
        </p>

        {bulk === null ? (
          <form className="ev-dict-pair ev-dict-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <input aria-label="Heard as" placeholder="Heard as, like “easy”" value={from} maxLength={128} disabled={disabled} onChange={(e) => setFrom(e.target.value)} className="ev-field-input" />
            <ArrowRight size={14} className="ev-dict-arrow" aria-hidden />
            <input aria-label="Type instead" placeholder="Type instead, like “Eavesy”" value={to} maxLength={128} disabled={disabled} onChange={(e) => setTo(e.target.value)} className="ev-field-input" />
            <span className="ev-dict-actions">
              <Button variant="primary" size="sm" type="submit" icon={Plus} loading={busy} disabled={disabled || !from.trim() || !to.trim()}>Add</Button>
              <Button variant="ghost" size="sm" icon={ListPlus} disabled={disabled} onClick={() => setBulk('')}>Add many</Button>
            </span>
          </form>
        ) : (
          <div className="ev-dict-bulk">
            <label htmlFor="dictionary-bulk" className="ev-set-label">Paste a list, one per line</label>
            <textarea
              id="dictionary-bulk"
              autoFocus
              className="ev-field-input"
              rows={6}
              value={bulk}
              disabled={busy}
              spellCheck={false}
              placeholder={'easy → Eavesy\ncube cuddle -> kubectl\npost hog = PostHog'}
              onChange={(e) => setBulk(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setBulk(null); } }}
            />
            <div className="ev-dict-bulk-foot">
              <p role="status" className="ev-set-hint">
                {parsed.entries.length || parsed.unread.length
                  ? [
                    `${parsed.entries.length} ready`,
                    parsed.unread.length ? `${parsed.unread.length} line${parsed.unread.length === 1 ? '' : 's'} without “→”` : null,
                    parsed.entries.length > MAX_BULK_REPLACEMENTS ? `up to ${MAX_BULK_REPLACEMENTS} at a time` : null,
                  ].filter(Boolean).join(' · ')
                  : 'Separate the two sides with →, ->, = or a tab.'}
              </p>
              <Button variant="ghost" size="sm" onClick={() => setBulk(null)}>Cancel</Button>
              <Button variant="primary" size="sm" loading={busy} disabled={busy || !parsed.entries.length || parsed.entries.length > MAX_BULK_REPLACEMENTS} onClick={addMany}>
                {parsed.entries.length > 1 ? `Add ${parsed.entries.length}` : 'Add'}
              </Button>
            </div>
          </div>
        )}

        {notice && (
          <p role="status" className="ev-set-hint flex items-center gap-2">
            {notice.text}
            {notice.undo && (
              <button type="button" className="ev-link" disabled={busy} onClick={() => { const back = notice.undo!; void run(async () => { await undoRemove(back); return 'Put back.'; }); }}>Undo</button>
            )}
          </p>
        )}
        {loading && <p role="status" className="ev-set-hint">Loading your dictionary…</p>}
        {error && <div role="alert" className="ev-settings-feedback"><p>{error}</p>{!loaded && <Button size="sm" variant="outline" disabled={busy || loading} onClick={() => void reload()}>Retry</Button>}</div>}

        {entries.length > FILTER_FROM && (
          <label className="ev-dict-filter">
            <Search size={13} aria-hidden />
            <input aria-label="Find a replacement" placeholder={`Find in ${entries.length}`} value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
        )}
        {shown.length > 0 && (
          <ul className="ev-dict-list">
            {shown.map((entry) => (
              <EntryRow key={entry.id} entry={entry} busy={busy} onSave={(nextFrom, nextTo) => edit(entry, { from: nextFrom, to: nextTo })} onRemove={() => remove(entry)} />
            ))}
          </ul>
        )}
        {loaded && !entries.length && !error && (
          <p className="ev-set-hint">Nothing here yet. Add one above, or fix a word in a transcript and Eavesy will remember it.</p>
        )}
        {loaded && entries.length > 0 && !shown.length && <p className="ev-set-hint">Nothing matches “{filter.trim()}”.</p>}
      </div>
    </Card>
  );
}
