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
    body: 'In the Mac app, press ⌘⇧D to talk, or open the launcher with ⌘⇧Space to record a meeting (your mic and the call’s audio), record a video of your screen, or take a screenshot. Press ⌘V to keep what’s on your clipboard, or drop a file in. Each one is saved as a folder on your disk, with or without an account.',
  },
  {
    n: '02',
    title: 'Eavesy turns it into Markdown',
    body: 'Text and images are saved as they are. While you record, live captions are made on your Mac. When you’re signed in, the audio also uploads in segments for a cloud transcript and a brief with a title, summary, decisions, and action items. Segments mean a dropped connection or a restart doesn’t lose the recording.',
  },
  {
    n: '03',
    title: 'Copy it into any agent',
    body: 'Copy the Markdown and paste it into Claude, Cursor, ChatGPT, or any agent. You can edit it first, or regenerate a summary with a coding, research, customer, or meeting format.',
  },
  {
    n: '04',
    title: 'Or let your agent come get it',
    body: 'Captures live in a folder on your disk as Markdown and JSON, so an agent with file access can read them directly. Signed-in accounts can also add the MCP server to Claude, ChatGPT or Claude Code by URL and let an agent search recordings and dictations.',
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

      <section className="border-t border-ev-line px-6 py-16">
        <Container className="max-w-3xl">
          <div className="flex flex-col gap-px">
            {STAGES.map((stage) => (
              <div
                key={stage.n}
                className="flex gap-6 border-b border-ev-line py-8 last:border-0"
              >
                <div className="text-2xl font-semibold text-ev-ink-2">{stage.n}</div>
                <div>
                  <h2 className="text-xl font-semibold text-ev-ink">{stage.title}</h2>
                  <p className="mt-2 leading-relaxed text-ev-ink-2">{stage.body}</p>
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
