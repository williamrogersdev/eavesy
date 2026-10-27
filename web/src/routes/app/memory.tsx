import { createFileRoute } from '@tanstack/react-router';
import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from '@/components/ui/app-link';
import { AppAlert, AppPage, AppPageHeader, AppSection, appButton } from '@/components/ui/app-page';
import type { LibraryAnswer } from '@/lib/ai/library-answer';

export const Route = createFileRoute('/app/memory')({ component: Memory });

const MAX_PAGES = 20;

interface ReindexResponse {
  error?: string;
  code?: string;
  queued?: number;
  cursor?: string | null;
}

class ReindexError extends Error {
  constructor(message: string, readonly dailyLimit: boolean) {
    super(message);
  }
}

function Memory() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<LibraryAnswer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [resumeCursor, setResumeCursor] = useState<string | null>(null);
  const [indexMessage, setIndexMessage] = useState('');

  async function reindex() {
    setIndexing(true);
    setError('');
    setIndexMessage('');
    let cursor: string | null = resumeCursor;
    let queued = 0;
    const seen = new Set<string>();
    let pages = 0;
    try {
      do {
        if (++pages > MAX_PAGES || (cursor && seen.has(cursor))) {
          throw new ReindexError('Indexing stopped at its page limit. Continue in a moment.', false);
        }
        if (cursor) seen.add(cursor);
        const r: Response = await fetch('/api/library/reindex', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cursor: cursor ?? undefined }),
        });
        const data: ReindexResponse = await r.json<ReindexResponse>().catch(() => ({}));
        if (!r.ok) {
          throw new ReindexError(data.error ?? 'Could not index your library.', r.status === 429 && data.code === 'daily_quota');
        }
        queued += data.queued ?? 0;
        cursor = data.cursor ?? null;
        setResumeCursor(cursor);
      } while (cursor);
      setIndexMessage(`Queued ${queued} recordings for indexing. Processing continues in the cloud.`);
    } catch (e) {
      const dailyLimit = e instanceof ReindexError && e.dailyLimit;
      setIndexMessage(
        `Queued ${queued} recordings before stopping. Processing continues in the cloud. ` +
          (dailyLimit
            ? 'You can continue from here after the daily limit resets at midnight UTC.'
            : 'You can continue from here.'),
      );
      setError(e instanceof Error ? e.message : 'Could not index your library.');
    } finally {
      setIndexing(false);
    }
  }

  async function ask() {
    setBusy(true);
    setAnswer(null);
    setError('');
    try {
      const response = await fetch('/api/library/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const data = await response.json<LibraryAnswer & { error?: string }>();
      if (!response.ok) throw new Error(data.error ?? 'Could not answer');
      setAnswer(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not answer');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppPage width="reading">
      <AppPageHeader
        title="Ask your library"
        description="Find decisions, commitments and open questions across completed recordings. Answers quote their sources and link to the recording."
      />

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <input
          className="h-10 min-w-0 flex-1 rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-3 text-sm outline-none focus:border-ev-coat focus:shadow-[var(--ev-focus)]"
          aria-label="Question about your recordings"
          value={question}
          minLength={3}
          maxLength={1000}
          required
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What did we agree about the launch?"
        />
        <button className={appButton('primary')} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {busy ? 'Searching…' : 'Ask'}
        </button>
      </form>

      {error ? <AppAlert>{error}</AppAlert> : null}

      <div aria-live="polite" className="flex flex-col gap-4">
        {answer?.abstained ? (
          <AppAlert tone="info">I couldn’t find enough evidence in your recordings to answer that.</AppAlert>
        ) : null}
        {answer?.warnings?.map((warning, i) => (
          <p className="text-sm text-ev-ink-2" key={`${i}:${warning}`}>{warning}</p>
        ))}
        {answer?.unanswered?.length ? (
          <div className="rounded-[var(--ev-r-panel)] bg-ev-well p-4">
            <p className="font-round text-[14px] font-bold text-ev-ink">Not established by these recordings</p>
            <ul className="mt-1 list-inside list-disc text-sm text-ev-ink-2">
              {answer.unanswered.map((part, i) => <li key={`${i}:${part}`}>{part}</li>)}
            </ul>
          </div>
        ) : null}
        {answer?.claims.length ? (
          <ul className="flex flex-col gap-3">
            {answer.claims.map((claim, i) => (
              <li className="flex flex-col gap-2 rounded-[var(--ev-r-panel)] p-4 shadow-[inset_0_0_0_1px_var(--ev-line)]" key={i}>
                <p className="font-round text-[12px] font-semibold uppercase tracking-wide text-ev-ink-3">{claim.kind.replace('_', ' ')}</p>
                <p className="text-[15px] leading-relaxed text-ev-ink">{claim.text}</p>
                {claim.citations.map((source) => (
                  <blockquote key={`${source.id}:${source.quote}`} className="border-l-2 border-ev-line-strong pl-3 text-sm text-ev-ink-2">
                    <p>“{source.quote}”</p>
                    <Link className="font-semibold text-ev-coat hover:text-ev-coat-hover" href={source.href}>
                      {source.title} · {Math.floor(source.startMs / 60000)}:{String(Math.floor(source.startMs / 1000) % 60).padStart(2, '0')}
                    </Link>
                  </blockquote>
                ))}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <AppSection
        title="Library index"
        description="Recordings are indexed as they finish. Refresh the index if older recordings are missing from answers."
        action={
          <button className={appButton('secondary', 'sm')} disabled={indexing} onClick={() => void reindex()}>
            {indexing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {indexing ? 'Queueing…' : resumeCursor ? 'Continue indexing' : 'Refresh library index'}
          </button>
        }
      >
        {indexMessage ? <p role="status" className="text-sm text-ev-ink-2">{indexMessage}</p> : null}
        <Link href="/app/import" className="text-sm font-semibold text-ev-coat hover:text-ev-coat-hover">Import recordings →</Link>
      </AppSection>
    </AppPage>
  );
}
