import { createFileRoute } from '@tanstack/react-router';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/terms/')({
  head: () =>
    seoHead({
      title: 'Terms',
      description:
        'Eavesy terms of service: you own your recordings, transcripts, summaries, and notes. We don’t sell your data, train on it, or share transcript content with analytics vendors.',
      path: '/terms',
    }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16 text-sm">
      <h1 className="text-3xl font-semibold tracking-tight">Terms</h1>
      <p className="text-muted-foreground">Last updated: {new Date().getFullYear()}.</p>

      <section>
        <p>
          Eavesy is provided as-is during pre-launch. You retain ownership of your meeting
          recordings, transcripts, summaries, and notes. By using the service you grant
          Eavesy the limited rights necessary to operate it on your behalf —
          transcription, summarization, storage, and synchronization across the surfaces you
          enable.
        </p>
        <p className="mt-4">
          Don't use Eavesy to record people without consent in jurisdictions where that's
          unlawful. Comply with your local recording laws.
        </p>
        <p className="mt-4">
          We don't sell your data, train on it, or share transcript content with analytics
          vendors. See the <a href="/privacy" className="underline">privacy policy</a> for the
          full subprocessor list.
        </p>
      </section>
    </main>
  );
}
