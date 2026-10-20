import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Link } from '@/components/ui/app-link';
import type { LibraryAnswer } from '@/lib/ai/library-answer';
export const Route = createFileRoute('/app/memory')({ component: Memory });
function Memory() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<LibraryAnswer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [indexMessage, setIndexMessage] = useState('');
  async function reindex() {
    setIndexing(true); setError(''); let cursor: string | null = null; let queued = 0; const seen = new Set<string>(); let pages = 0;
    try {
      do {
        if (++pages > 20 || (cursor && seen.has(cursor))) throw new Error('Indexing stopped at its page limit. Retry later.');
        if (cursor) seen.add(cursor);
        const r: Response = await fetch('/api/library/reindex', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cursor: cursor ?? undefined }) });
        const data: { error?: string; queued: number; cursor: string | null } = await r.json<{ error?: string; queued: number; cursor: string | null }>();
        if (!r.ok) throw new Error(data.error ?? 'Could not index library');
        queued += data.queued; cursor = data.cursor;
      } while (cursor);
      setIndexMessage(`Queued ${queued} recordings for indexing. Processing continues in the cloud.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not index library'); }
    finally { setIndexing(false); }
  }
  async function ask() {
    setBusy(true); setAnswer(null); setError('');
    try {
      const response = await fetch('/api/library/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) });
      const data = await response.json<LibraryAnswer & { error?: string }>();
      if (!response.ok) throw new Error(data.error ?? 'Could not answer');
      setAnswer(data);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not answer'); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto max-w-3xl space-y-6 p-8">
    <h1 className="text-2xl font-semibold">Ask your library</h1>
    <p className="text-sm text-muted-foreground">Find decisions, commitments and open questions across completed recordings. Answers include the exact words and a link to the source.</p>
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void ask(); }}>
      <input className="min-w-0 flex-1 rounded border bg-background p-3" aria-label="Question about your recordings" value={question} minLength={3} maxLength={1000} required onChange={e => setQuestion(e.target.value)} placeholder="What did we agree about the launch?" />
      <button className="rounded bg-accent px-4 text-white disabled:opacity-50" disabled={busy}>{busy ? 'Searching…' : 'Ask'}</button>
    </form>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <div aria-live="polite">
      {answer?.abstained && <p>I couldn’t find enough evidence in your recordings to answer that.</p>}
      <ul className="space-y-4">{answer?.claims.map((claim, i) => <li className="space-y-2 rounded-lg border p-4" key={i}>
        <p className="text-xs text-muted-foreground">{claim.kind.replace('_', ' ')}</p>
        <p>{claim.text}</p>
        {claim.citations.map(source => <blockquote key={`${source.id}:${source.quote}`} className="border-l-2 pl-3 text-sm text-muted-foreground">
          <p>“{source.quote}”</p><Link className="text-accent" href={source.href}>{source.title} · {Math.floor(source.startMs / 60000)}:{String(Math.floor(source.startMs / 1000) % 60).padStart(2, '0')}</Link>
        </blockquote>)}
      </li>)}</ul>
    </div>
    <button className="rounded border px-3 py-2 text-sm" disabled={indexing} onClick={() => void reindex()}>{indexing ? 'Queueing…' : 'Refresh library index'}</button>
    <p role="status" className="text-sm text-muted-foreground">{indexMessage}</p>
    <Link href="/app/import" className="text-accent">Import recordings →</Link>
  </div>;
}
