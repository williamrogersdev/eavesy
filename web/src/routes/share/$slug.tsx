import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { Link } from '@/components/ui/app-link';

/** Public, read-only meeting notes behind a share link (`/api/share/$slug`). */
export const Route = createFileRoute('/share/$slug')({
  head: () => ({ meta: [{ title: 'Meeting notes · Eavesy' }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: SharedNotesPage,
});

interface SharedNotes {
  title: string;
  startedAt: number | null;
  summaryMd: string | null;
  tldr: string;
  decisions: string[];
  actionItems: { text: string; owner: string | null; due: string | null; completed: boolean }[];
}

function SharedNotesPage() {
  const { slug } = Route.useParams();
  const [notes, setNotes] = useState<SharedNotes | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    void fetch(`/api/share/${encodeURIComponent(slug)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        setNotes(await response.json<SharedNotes>());
      })
      .catch(() => setMissing(true));
  }, [slug]);

  const started = notes?.startedAt ? new Date(notes.startedAt) : null;
  return (
    <main className="ev mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 bg-ev-paper px-4 py-10 text-ev-ink sm:px-6">
      <Link href="/" className="w-fit" aria-label="Eavesy"><BrandMark size={32} /></Link>
      {missing ? (
        <p className="text-sm text-ev-ink-2">These notes aren’t available. The link may have expired; ask whoever sent it for a new one.</p>
      ) : !notes ? (
        <p className="text-sm text-ev-ink-2">Loading…</p>
      ) : (
        <article className="flex flex-col gap-5">
          <header>
            <h1 className="font-round text-[26px] font-extrabold tracking-tight">{notes.title}</h1>
            {started && Number.isFinite(started.getTime()) ? (
              <p className="mt-1 text-sm text-ev-ink-2">
                {started.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              </p>
            ) : null}
          </header>
          {notes.summaryMd ? (
            <div className="whitespace-pre-wrap text-[15px] leading-relaxed">{notes.summaryMd}</div>
          ) : (
            <>
              <section>
                <h2 className="mb-1.5 font-round text-[15px] font-bold">Summary</h2>
                <p className="text-[15px] leading-relaxed">{notes.tldr || 'No summary was written for this meeting.'}</p>
              </section>
              {notes.actionItems.length ? (
                <section>
                  <h2 className="mb-1.5 font-round text-[15px] font-bold">Action items</h2>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {notes.actionItems.map((a, i) => (
                      <li key={i} className={a.completed ? 'text-ev-ink-3 line-through' : undefined}>
                        {a.owner ? <strong className="font-semibold">{a.owner}: </strong> : null}
                        {a.text}
                        {a.due ? <span className="text-ev-ink-3"> · due {a.due}</span> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {notes.decisions.length ? (
                <section>
                  <h2 className="mb-1.5 font-round text-[15px] font-bold">Decisions</h2>
                  <ul className="list-disc space-y-1 pl-5 text-sm">{notes.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
                </section>
              ) : null}
            </>
          )}
          <p className="border-t border-ev-line pt-4 text-xs text-ev-ink-3">
            Notes taken with <Link href="/" className="underline">Eavesy</Link>.
          </p>
        </article>
      )}
    </main>
  );
}
