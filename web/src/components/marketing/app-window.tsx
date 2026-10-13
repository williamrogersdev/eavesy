import { Check, Mic, Sparkles } from 'lucide-react';
import { Equalizer } from './waveform';

const TRANSCRIPT = [
  'Okay, so for Q3 the big rock is shipping the mobile app.',
  'Agreed. I think we lock the scope to recording and sync, nothing else.',
  "Works for me. Let's target the last week of August for the beta.",
];

const TOPICS = ['Q3 roadmap', 'Mobile app', 'Beta timeline'];

const ACTION_ITEMS = [
  { who: 'Marcus', task: 'own timeline, send invites by Fri' },
  { who: 'Sarah', task: 'confirm late-Aug beta date' },
];

export function AppWindow() {
  return (
    <div className="relative mx-auto w-full max-w-4xl">
      <div className="absolute -inset-x-8 -top-8 bottom-0 -z-10 rounded-[40px] bg-accent/10 blur-3xl" />
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0b0b11] shadow-2xl shadow-black/60 ring-1 ring-white/5">
        <TitleBar />
        <RecordingBar />
        <div className="grid grid-cols-1 divide-white/[0.07] sm:grid-cols-[1.15fr_1fr] sm:divide-x">
          <TranscriptPane />
          <SummaryPane />
        </div>
      </div>
    </div>
  );
}

function TitleBar() {
  return (
    <div className="flex items-center gap-3 border-b border-white/[0.07] bg-white/[0.02] px-4 py-3">
      <span className="flex gap-2">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
      </span>
      <div className="mx-auto flex items-center gap-2 rounded-md bg-white/[0.04] px-3 py-1 text-xs text-white/50">
        <Mic className="h-3 w-3" /> Eavesy — Q3 Planning
      </div>
    </div>
  );
}

function RecordingBar() {
  return (
    <div className="flex items-center gap-3 bg-action px-4 py-2.5 text-sm font-medium text-white">
      <span className="h-2.5 w-2.5 animate-recording-pulse rounded-full bg-white" />
      <span className="font-mono tabular-nums">14:32</span>
      <span className="opacity-80">Recording</span>
      <Equalizer />
      <span className="ml-auto rounded-md bg-black/25 px-2.5 py-1 text-xs font-semibold">Stop</span>
    </div>
  );
}

function TranscriptPane() {
  return (
    <div className="space-y-4 p-5 text-sm">
      <PaneLabel>Rolling transcript</PaneLabel>
      {TRANSCRIPT.map((t) => (
        <p key={t} className="text-white/80">{t}</p>
      ))}
      <p className="text-white/80">
        I&apos;ll own the timeline and send invites by Friday
        <span className="ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 animate-recording-pulse bg-[var(--signal)]" />
      </p>
    </div>
  );
}

function SummaryPane() {
  return (
    <div className="space-y-4 bg-white/[0.015] p-5 text-sm">
      <PaneLabel icon>Rolling notes</PaneLabel>

      <div>
        <SubLabel>Topics</SubLabel>
        <div className="flex flex-wrap gap-1.5">
          {TOPICS.map((t) => (
            <span key={t} className="rounded-md bg-white/[0.06] px-2 py-0.5 text-xs text-white/70">{t}</span>
          ))}
        </div>
      </div>

      <div>
        <SubLabel>Decisions</SubLabel>
        <p className="flex gap-2 text-white/75">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/80" />
          Scope the mobile beta to recording + sync only.
        </p>
      </div>

      <div>
        <SubLabel>Action items</SubLabel>
        <ul className="space-y-1.5 text-white/75">
          {ACTION_ITEMS.map((a) => (
            <li key={a.who} className="flex gap-2">
              <span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-[4px] border border-white/25" />
              <span><b className="text-white/90">{a.who}</b> — {a.task}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PaneLabel({ children, icon }: { children: React.ReactNode; icon?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/50">
      {icon ? <Sparkles className="h-3 w-3 text-accent" /> : null}
      {children}
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[11px] font-semibold text-white/50">{children}</div>;
}
