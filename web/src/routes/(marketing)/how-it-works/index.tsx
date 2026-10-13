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
        'From hitting record to a brief you paste into your agent: how Eavesy captures long sessions, transcribes rolling segments, and saves AI-ready context to your disk.',
      path: '/how-it-works',
    }),
  component: HowItWorksPage,
});

const STAGES = [
  {
    n: '01',
    title: 'Capture your screen and voice — no bot required',
    body: 'Eavesy records your Mac’s screen, system audio, and microphone. That covers a Zoom call, a product walkthrough, a bug reproduction, or an in-person conversation. No bot joins the call; you choose when capture starts and remain responsible for participant consent.',
  },
  {
    n: '02',
    title: 'Transcribe in recoverable rolling segments',
    body: 'As you talk, Eavesy seals and uploads short segments while capture continues. Each segment is durable on disk first, so a network interruption or app restart does not sacrifice the whole session.',
  },
  {
    n: '03',
    title: 'Finalize an AI-ready brief after you stop',
    body: 'Eavesy distills the session into a clean Markdown brief: a title, TL;DR, key points, and the steps you took, sitting on top of the full transcript. Copy it straight into your agent, edit it, or regenerate it with a purpose-built format.',
  },
  {
    n: '04',
    title: 'Keep the context as a file you own',
    body: 'Every session is written to a real folder on your disk: summary Markdown, full transcript Markdown, and M4A audio. Point an agent at it, open it in Obsidian, or search it later.',
  },
];

function HowItWorksPage() {
  return (
    <main className="flex flex-1 flex-col">
      <PageHero
        eyebrow="How it works"
        title="From “hit record” to context your AI can use"
        description="Four steps, none of which involve you typing context by hand. Here’s exactly what happens between starting a recording and pasting a brief into your agent."
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
