import { FileText, Mic, MonitorSmartphone, Sparkles, Waves, FolderTree } from 'lucide-react';
import type { ShowcaseVisual } from './content';
import { Equalizer, LevelBars } from './waveform';

export function ShowcaseVisualFor({ kind }: { kind: ShowcaseVisual }) {
  switch (kind) {
    case 'capture':
      return <CaptureVisual />;
    case 'summary':
      return <SummaryVisual />;
    case 'files':
      return <FilesVisual />;
  }
}

function Frame({ children, glow }: { children: React.ReactNode; glow: string }) {
  return (
    <div className="relative">
      <div className={`absolute -inset-6 -z-10 rounded-3xl ${glow} blur-3xl`} />
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0b0b11] p-5 shadow-xl shadow-black/40">
        {children}
      </div>
    </div>
  );
}

function CaptureVisual() {
  return (
    <Frame glow="bg-accent/15">
      <div className="flex items-center gap-3 rounded-xl bg-action px-4 py-3 text-sm font-medium text-white">
        <span className="h-2.5 w-2.5 animate-recording-pulse rounded-full bg-white" />
        <span className="font-mono">08:12</span> Recording
        <Equalizer />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <ChannelMeter icon={Mic} label="Mic" />
        <ChannelMeter icon={MonitorSmartphone} label="System" />
      </div>
    </Frame>
  );
}

function ChannelMeter({ icon: Icon, label }: { icon: typeof Mic; label: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between text-white/55">
        <span className="flex items-center gap-1.5"><Icon className="h-3 w-3" /> {label}</span>
        <span className="text-[var(--signal)]">●</span>
      </div>
      <LevelBars />
    </div>
  );
}

function SummaryVisual() {
  const items = [
    { who: 'Marcus', task: 'Own timeline, send invites Fri' },
    { who: 'Sarah', task: 'Confirm beta date' },
    { who: 'Priya', task: 'Draft scope doc' },
  ];
  return (
    <Frame glow="bg-accent/15">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/50">
        <Sparkles className="h-3.5 w-3.5 text-accent" /> AI summary
      </div>
      <p className="mt-3 text-sm text-white/80">
        Team aligned on shipping the mobile beta in late August, scoped to recording and sync.
      </p>
      <div className="mt-4 space-y-2 text-sm">
        {items.map((a) => (
          <div key={a.who} className="flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
            <span className="h-4 w-4 rounded-[5px] border border-white/25" />
            <span className="text-white/75"><b className="text-white/90">{a.who}</b> — {a.task}</span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

function FilesVisual() {
  const files = [
    { name: 'summary.md', icon: FileText },
    { name: 'transcript.md', icon: FileText },
    { name: 'audio.m4a', icon: Waves },
  ];
  return (
    <Frame glow="bg-accent/15">
      <div className="flex items-center gap-2 text-sm text-white/60">
        <FolderTree className="h-4 w-4 text-accent" />
        <span className="font-medium text-white/80">~/Eavesy/2026-06-12 Q3 Planning</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        {files.map((f) => (
          <div key={f.name} className="flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-sm text-white/75">
            <f.icon className="h-4 w-4 text-white/50" />
            {f.name}
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-lg border border-dashed border-white/10 px-3 py-2 text-center text-xs text-white/50">
        Drop into Obsidian, Dropbox, or any folder — it just works
      </div>
    </Frame>
  );
}
