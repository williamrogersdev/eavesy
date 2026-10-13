import { createFileRoute } from '@tanstack/react-router';
import {
  Breadcrumbs,
  CTASection,
  Container,
  PageHero,
} from '@/components/marketing/page-chrome';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/about/')({
  head: () =>
    seoHead({
      title: 'About',
      description:
        'Why we built Eavesy: context capture for AI agents that leaves you with files you own, not transcripts locked in someone else’s cloud.',
      path: '/about',
    }),
  component: AboutPage,
});

const PRINCIPLES = [
  {
    title: 'Your context, your disk',
    body: 'Sessions are written as summary Markdown, transcript Markdown, and M4A audio to a folder you control. Feed them to any agent and keep the local copy even if you leave.',
  },
  {
    title: 'Capture from your own device',
    body: 'No bot joins the participant list. Eavesy records from your Mac when you start it, whether the work is a call, a walkthrough, or an in-person conversation.',
  },
  {
    title: 'Private by default',
    body: 'Platform transcription and summary providers state that customer content is not used for training by default. A connected OpenRouter account follows the privacy settings you control there. Operational analytics do not receive recording content.',
  },
  {
    title: 'Fast enough to forget it’s there',
    body: 'Rolling transcription and automatic briefs keep long sessions recoverable without interrupting the work. The best tool is the one you stop thinking about.',
  },
];

function AboutPage() {
  return (
    <main className="flex flex-1 flex-col">
      <PageHero
        eyebrow="About"
        title="Your AI should know what you know"
        description="Eavesy started from a simple frustration: AI agents are powerful but blind to what just happened on your screen and in your conversations — and getting that context to them meant retyping, screenshotting, and re-explaining. We thought there should be a record button for that."
      >
        <Breadcrumbs
          items={[
            { name: 'Home', path: '/' },
            { name: 'About', path: '/about' },
          ]}
        />
      </PageHero>

      <section className="px-6 py-16">
        <Container className="max-w-3xl">
          <div className="prose">
            <p>
              We build Eavesy for people who work alongside AI agents but keep
              hitting the same wall: the agent wasn’t there. It captures your
              screen and your voice, distills the session into a brief your agent
              can read, and saves all of it as files on your disk, in formats any
              tool can open.
            </p>
            <p>
              The product keeps local source files while using a private cloud copy
              for transcription, search, and recovery. You get portable files on your
              Mac and a clear account boundary around cloud processing.
            </p>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            {PRINCIPLES.map((p) => (
              <div
                key={p.title}
                className="rounded-2xl border border-white/10 bg-white/[0.02] p-6"
              >
                <h2 className="font-semibold text-white">{p.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-white/55">{p.body}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <CTASection />
    </main>
  );
}
