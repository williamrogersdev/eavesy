import { createFileRoute } from '@tanstack/react-router';
import {
  Breadcrumbs,
  CTASection,
  Container,
  PageHero,
} from '@/components/marketing/page-chrome';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/how-it-works/')({
  head: () =>
    seoHead({
      title: 'How it works',
      description:
        'How Eavesy works: drop in clipboard text, screenshots, dictation, or recordings, get clean Markdown, and paste it into any AI agent or reach it over MCP.',
      path: '/how-it-works',
    }),
  component: HowItWorksPage,
});

const STAGES = [
  {
    n: '01',
    title: 'Drop something in',
    body: 'In the Mac app, open the launcher with a hotkey, then press ⌘V to save text or an image from your clipboard, or take a screenshot, dictate, or record your screen, system audio, and microphone. Each one is saved as a capture. Dropping in messages or orders from other apps directly is not available yet; for now, copy and paste them.',
  },
  {
    n: '02',
    title: 'Eavesy turns it into Markdown',
    body: 'Text and images are saved as they are. Audio is transcribed and summarized into structured Markdown with a title, TL;DR, decisions, and action items. Long recordings are sealed into recoverable segments, so a network interruption or restart does not lose the session. Transcripts arrive a little after the audio is processed, not as live captions.',
  },
  {
    n: '03',
    title: 'Copy it into any agent',
    body: 'Copy the Markdown and paste it into Claude, Cursor, ChatGPT, or any agent. You can edit it first, or regenerate a summary with a coding, research, customer, or meeting format.',
  },
  {
    n: '04',
    title: 'Or let your agent come get it',
    body: 'Captures live in a folder on your disk as Markdown and JSON, so an agent with filesystem access can read them directly. Signed-in accounts can also add the hosted MCP server to Claude, ChatGPT or Claude Code by URL and let an agent search recordings and dictations.',
  },
];

function HowItWorksPage() {
  return (
    <main className="flex flex-1 flex-col">
      <PageHero
        eyebrow="How it works"
        title="From “drop it in” to context your AI can use"
        description="Four steps, none of which involve you retyping context by hand. Here’s what happens between dropping something into Eavesy and pasting it into your agent."
      >
        <Breadcrumbs
          items={[
            { name: 'Home', path: '/' },
            { name: 'How it works', path: '/how-it-works' },
          ]}
        />
      </PageHero>

      <section className="border-t border-white/[0.06] px-6 py-16">
        <Container className="max-w-3xl">
          <div className="flex flex-col gap-px">
            {STAGES.map((stage) => (
              <div
                key={stage.n}
                className="flex gap-6 border-b border-white/[0.06] py-8 last:border-0"
              >
                <div className="text-2xl font-semibold text-white/50">{stage.n}</div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{stage.title}</h2>
                  <p className="mt-2 leading-relaxed text-white/55">{stage.body}</p>
                </div>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <CTASection />
    </main>
  );
}
