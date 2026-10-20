import { Button, Card } from '@/components/launcher/ui';
import { useEffect, useState } from 'react';
import { dictionaryRequest } from '@/lib/desktop/bridge';

type Entry = { id: string; from: string; to: string };
export function DictionarySettings() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => { const result = await dictionaryRequest<{ entries: Entry[] }>('GET'); setEntries(result.entries); };
  useEffect(() => { load().catch(() => setError('Connect your Eavesy account to load your dictionary.')); }, []);
  const mutate = async (method: 'PUT' | 'DELETE', body: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { const result = await dictionaryRequest<{ learned?: number }>(method, body);
      if (method === 'PUT' && result.learned === 0) throw new Error('Dictionary is full. Forget an entry before adding another.');
      await load(); setFrom(''); setTo(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update dictionary'); }
    finally { setBusy(false); }
  };
  return <Card title="Personal dictionary"><div className="ev-set-body space-y-3">
    
    <p className="text-sm text-[var(--ev-ink-2)]">Corrections you make teach future recordings. Review or remove learned spellings here.</p>
    <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); void mutate('PUT', { from, to }); }}>
      <input aria-label="Misheard word or phrase" placeholder="Misheard phrase" value={from} maxLength={128} required onChange={e => setFrom(e.target.value)} className="ev-field-input min-w-0 flex-1" />
      <input aria-label="Correct spelling" placeholder="Correct spelling" value={to} maxLength={128} required onChange={e => setTo(e.target.value)} className="ev-field-input min-w-0 flex-1" />
      <Button size="sm" type="submit" disabled={busy || !from.trim() || !to.trim()}>Add correction</Button>
    </form>
    {error && <p role="alert" className="text-sm text-[var(--ev-warn)]">{error}</p>}
    <ul className="max-h-52 overflow-y-auto text-sm">{entries.map(entry => <li key={entry.id} className="flex items-center justify-between gap-3 border-b border-[var(--ev-line)] py-2">
      <span>{entry.from} → <strong>{entry.to}</strong></span>
      <Button size="sm" type="button" disabled={busy} aria-label={`Forget ${entry.to}`} onClick={() => void mutate('DELETE', { id: entry.id })}>Forget</Button>
    </li>)}</ul>
    {!entries.length && !error && <p className="text-xs text-[var(--ev-ink-2)]">No learned words yet.</p>}
  </div></Card>;
}
