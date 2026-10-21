import { Button, Card, Row } from '@/components/launcher/ui';
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
    try { await dictionaryRequest<{ learned?: number }>(method, body);
      await load(); setFrom(''); setTo(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update dictionary'); }
    finally { setBusy(false); }
  };
  return (
    <Card title="Learned spellings">
      <div className="ev-set-row flex-col items-stretch gap-2">
        <div>
          <div className="ev-set-label">Corrections</div>
          <div className="ev-set-hint">Fixes you make teach later recordings. Add one yourself, or forget one that’s wrong.</div>
        </div>
        <form className="flex gap-1.5" onSubmit={e => { e.preventDefault(); void mutate('PUT', { from, to }); }}>
          <input aria-label="Misheard word or phrase" placeholder="Heard as" value={from} maxLength={128} required onChange={e => setFrom(e.target.value)} className="ev-field-input min-w-0 flex-1" />
          <input aria-label="Correct spelling" placeholder="Should be" value={to} maxLength={128} required onChange={e => setTo(e.target.value)} className="ev-field-input min-w-0 flex-1" />
          <Button size="sm" variant="outline" type="submit" className="shrink-0 self-center" disabled={busy || !from.trim() || !to.trim()}>Add</Button>
        </form>
        {error && <p role="alert" className="ev-set-hint text-[var(--ev-warn-ink)]">{error}</p>}
      </div>
      {entries.map(entry => (
        <Row key={entry.id} label={<>{entry.from} <span className="text-[var(--ev-ink-3)]">→</span> {entry.to}</>}>
          <Button size="sm" variant="ghost" type="button" disabled={busy} aria-label={`Forget ${entry.to}`} onClick={() => void mutate('DELETE', { id: entry.id })}>Forget</Button>
        </Row>
      ))}
      {!entries.length && !error && <p className="ev-set-hint px-3 py-2.5">Nothing learned yet.</p>}
    </Card>
  );
}
