import { Button, Card } from '@/components/launcher/ui';
import { useCallback, useEffect, useState } from 'react';
import { dictionaryRequest } from '@/lib/desktop/bridge';

type Entry = { id: string; from: string; to: string };
export function DictionarySettings() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => { const result = await dictionaryRequest<{ entries: Entry[] }>('GET'); setEntries(result.entries); setLoaded(true); }, []);
  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try { await load(); }
    catch { setError('Your dictionary could not be loaded. Check your connection to eavesy.com and try again.'); }
    finally { setLoading(false); }
  }, [load]);
  useEffect(() => { void reload(); }, [reload]);
  const mutate = async (method: 'PUT' | 'DELETE', body: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { const result = await dictionaryRequest<{ learned?: number }>(method, body);
      if (method === 'PUT' && result.learned === 0 && !entries.some((entry) => entry.from === from && entry.to === to)) throw new Error('No new correction was saved. Refresh the dictionary to check existing spellings, then try again.');
      await load(); setFrom(''); setTo(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update dictionary'); }
    finally { setBusy(false); }
  };
  return <Card title="Personal dictionary"><div className="ev-set-body space-y-3">
    
    <p className="text-sm text-[var(--ev-ink-2)]">Corrections you make teach future recordings. Review or remove learned spellings here.</p>
    <form className="ev-dictionary-form" onSubmit={e => { e.preventDefault(); void mutate('PUT', { from, to }); }}>
      <label>Heard as<input aria-label="Misheard word or phrase" placeholder="Misheard word or phrase" value={from} maxLength={128} disabled={!loaded || busy} required onChange={e => setFrom(e.target.value)} className="ev-field-input" /></label>
      <label>Write instead<input aria-label="Correct spelling" placeholder="Your preferred spelling" value={to} maxLength={128} disabled={!loaded || busy} required onChange={e => setTo(e.target.value)} className="ev-field-input" /></label>
      <Button variant="primary" size="sm" type="submit" loading={busy} disabled={!loaded || busy || !from.trim() || !to.trim()}>Add correction</Button>
    </form>
    {loading && <p role="status" className="ev-set-hint">Loading your dictionary…</p>}
    {error && <div role="alert" className="ev-settings-feedback"><p>{error}</p><Button size="sm" variant="outline" disabled={busy || loading} onClick={() => void reload()}>Retry</Button></div>}
    <ul className="ev-dictionary-list">{entries.map(entry => <li key={entry.id}>
      <span>{entry.from} → <strong>{entry.to}</strong></span>
      <Button size="sm" type="button" disabled={busy} aria-label={`Forget ${entry.to}`} onClick={() => void mutate('DELETE', { id: entry.id })}>Forget</Button>
    </li>)}</ul>
    {loaded && !entries.length && !error && <p className="ev-set-hint">No learned spellings yet. Add one above, or correct a transcript to teach Eavesy.</p>}
  </div></Card>;
}
