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
      <h1 className="text-3xl font-extrabold tracking-tight">Privacy</h1>
      <p className="text-muted-foreground">Last updated: {new Date().getFullYear()}.</p>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">What we promise</h2>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <strong>Local first.</strong> In the Mac app, every capture is a real folder on
            your disk: Markdown, JSON metadata, and audio, video or images. You can use it
            without an account. When you sign in, recordings also get a cloud copy for
            transcripts, briefs, search and sync. Screenshots, clipboard captures and notes
            from the Mac app are never uploaded. Anything you capture in the web app, including
            screenshots and screen or webcam video, is stored in your account. A Notetaker
            you send to a call records that call&rsquo;s audio, the participants&rsquo; display
            names and who spoke when, never video, and stores them in your account the same way.
          </li>
          <li>
            <strong>Encrypted in transit and at rest.</strong> TLS protects data in transit.
            Cloudflare-managed encryption protects R2 objects and D1 data at rest.
          </li>
          <li>
            <strong>Keys stay where they belong.</strong> The Mac app keeps only its device
            token in your macOS Keychain. If you bring your own AI keys, you enter them on the web
            and they are stored encrypted.
          </li>
          <li>
            <strong>Analytics and error reports never receive recording content</strong>, audio,
            transcript text, summaries, or notes. Eavesy uses PostHog to count page views and
            product events (for example &ldquo;a Mac was paired&rdquo; or &ldquo;a dictation was
            pasted&rdquo;, never what was said) and to receive error reports (the error message, the
            page or API route, and the app version) with emails, IP addresses, tokens, file paths,
            page titles, and request bodies removed. There is no session recording and no
            advertising tracking.
          </li>
          <li>
            <strong>Eavesy does not train models on recording content.</strong> Cloudflare
            Workers AI and Anthropic&rsquo;s commercial API state that customer content is not
            used for model training without an explicit opt-in. A connected OpenRouter account
            follows the provider privacy settings you control there.
          </li>
          <li>
            <strong>Portable export.</strong> Export everything from Settings → Your data, or a
            single recording from its page. Mac captures are already normal local files.
          </li>
          <li>
            <strong>Deletion that includes cloud copies.</strong> Delete any recording, or your
            whole account from Settings → Your data. Cloud copies (audio, transcripts, search index) are
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
          <li><strong>Cloudflare</strong> — all infrastructure (Workers, R2, D1, Vectorize, Queues, KV, and Containers, where the Notetaker runs), plus Workers AI for transcription (Whisper) and semantic-search embeddings</li>
          <li><strong>Clerk</strong> — authentication</li>
          <li><strong>OpenRouter</strong> — optional bring-your-own AI connection</li>
          <li><strong>PostHog</strong> — product analytics and scrubbed error reports from the web app, browser, and Mac app; never recording content</li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">BYO keys</h2>
        <p>
          In the web app, Settings → AI providers lets you connect OpenRouter or add your own
          Anthropic API key for summaries and chat. Keys are stored encrypted. When configured,
          those calls bill to your account. Calls still flow through Eavesy so the service can
          assemble the requested context and prompts.
        </p>
      </section>
    </main>
  );
}
