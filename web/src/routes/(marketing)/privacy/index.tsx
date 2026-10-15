import { createFileRoute } from '@tanstack/react-router';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/privacy/')({
  head: () =>
    seoHead({
      title: 'Privacy',
      description:
        'How Eavesy handles data: local + cloud copies, encryption, model-provider policies, subprocessors, export, and deletion controls.',
      path: '/privacy',
    }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16 text-sm">
      <h1 className="text-3xl font-semibold tracking-tight">Privacy</h1>
      <p className="text-muted-foreground">Last updated: {new Date().getFullYear()}.</p>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">What we promise</h2>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <strong>Local + cloud, both real.</strong> On desktop, every meeting lives as a real
            folder on your disk — Markdown summary, full transcript, audio, JSON metadata — in
            addition to the cloud copy. You can open these in Obsidian, drag them to Dropbox,
            or inspect them in VS Code.
          </li>
          <li>
            <strong>Encrypted in transit and at rest.</strong> TLS protects data in transit.
            Cloudflare-managed encryption protects R2 objects and D1 data at rest.
          </li>
          <li>
            <strong>API keys in your OS keychain</strong> on desktop. Encrypted at rest in the
            cloud for web/mobile.
          </li>
          <li>
            <strong>Operational analytics do not receive recording content</strong>, audio,
            transcript text, summaries, or notes. Eavesy does not use a product analytics service;
            the optional Sentry integration, when enabled, receives error reports (the error
            message, the page or API route, and the app version) with emails, tokens, file paths,
            and request bodies removed.
          </li>
          <li>
            <strong>Eavesy does not train models on recording content.</strong> Cloudflare
            Workers AI and Anthropic&rsquo;s commercial API state that customer content is not
            used for model training without an explicit opt-in. A connected OpenRouter account
            follows the provider privacy settings you control there.
          </li>
          <li>
            <strong>Portable export.</strong> Export everything from Settings, or a meeting bundle or
            capture from its detail page; Mac sessions also remain as normal local files.
          </li>
          <li>
            <strong>Deletion that includes cloud copies.</strong> Delete any recording, or your
            whole account from Settings. Cloud copies (audio, transcripts, search index) are
            permanently removed within a day; local folders remain under your control.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Who sees your data</h2>
        <p>
          A clear, public list of every third party that ever touches user data:
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li><strong>Anthropic</strong> — AI summaries &amp; action-item extraction under its commercial API policy</li>
          <li><strong>Cloudflare</strong> — all infrastructure (Workers, R2, D1, Vectorize, Queues, KV), plus Workers AI for transcription (Whisper) and semantic-search embeddings</li>
          <li><strong>Clerk</strong> — authentication</li>
          <li><strong>OpenRouter</strong> — optional bring-your-own AI connection</li>
          <li><strong>Sentry (optional)</strong> — scrubbed error reports from the web app, browser, and Mac app when enabled</li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">BYO keys</h2>
        <p>
          Settings lets you connect OpenRouter or supply your own Anthropic key for summaries
          and chat. When configured, those calls bill to your account. Calls still flow through
          Eavesy so the service can assemble the requested context and prompts.
        </p>
      </section>
    </main>
  );
}
