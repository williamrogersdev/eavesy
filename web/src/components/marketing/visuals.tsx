import { Check, FileText, FolderTree, Sparkles, Waves } from 'lucide-react';
import { Mascot } from '@/components/launcher/ui';
import type { ShowcaseVisual } from './content';
import { HudPreview } from './launcher-preview';

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

function Frame({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div aria-hidden className={`ev-tile relative overflow-hidden p-5 ${className}`}>{children}</div>;
}

function CaptureVisual() {
  return (
    <Frame className="flex min-h-[260px] flex-col items-center justify-center gap-6 bg-[linear-gradient(160deg,var(--ev-coat-soft),var(--ev-manila-soft))]">
      <HudPreview words={['Okay, the export button greys out', 'after I switch workspaces']} />
      <div className="flex w-full max-w-[300px] items-center gap-2.5 rounded-[var(--ev-r-pop)] bg-ev-raised px-3 py-2.5 shadow-[var(--ev-e-2)]">
        <Mascot size={22} state="happy" />
        <span className="font-round text-[13px] font-semibold text-ev-ink">Pasted</span>
        <span className="ml-auto font-round text-[11.5px] text-ev-ink-3">into Cursor</span>
      </div>
    </Frame>
  );
}

function SummaryVisual() {
  const items = [
    { who: 'Marcus', task: 'Own the timeline, send invites Fri' },
    { who: 'Sarah', task: 'Confirm the beta date' },
    { who: 'Priya', task: 'Draft the scope doc' },
  ];
  return (
    <Frame>
      <div className="flex items-center gap-1.5 font-round text-xs font-bold text-ev-ink-2">
        <Sparkles className="h-3.5 w-3.5 text-ev-coat" strokeWidth={1.75} /> Summary
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ev-ink">
        Team aligned on shipping the mobile beta in late August, scoped to recording and sync.
      </p>
      <div className="mt-4 font-round text-xs font-bold text-ev-ink-2">Action items</div>
      <div className="mt-2 space-y-1.5 text-sm">
        {items.map((a, i) => (
          <div key={a.who} className="flex items-center gap-2.5 rounded-[var(--ev-r-ctl)] bg-ev-well px-3 py-2">
            {i === 0 ? (
              <span className="grid h-4 w-4 place-items-center rounded-[5px] bg-ev-leaf text-ev-paper">
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
            ) : (
              <span className="h-4 w-4 rounded-[5px] border border-ev-line-strong" />
            )}
            <span className="text-ev-ink-2"><b className="font-semibold text-ev-ink">{a.who}</b> · {a.task}</span>
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
    { name: 'capture.json', icon: FileText },
    { name: 'audio.m4a', icon: Waves },
  ];
  return (
    <Frame>
      <div className="flex items-center gap-2 text-sm">
        <FolderTree className="h-4 w-4 text-ev-coat" strokeWidth={1.75} />
        <span className="font-round font-bold text-ev-ink">~/Eavesy/2026-06-12 Q3 Planning</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {files.map((f) => (
          <div key={f.name} className="flex items-center gap-2.5 rounded-[var(--ev-r-ctl)] bg-ev-well px-3 py-2.5 text-sm text-ev-ink">
            <f.icon className="h-4 w-4 text-ev-ink-2" strokeWidth={1.75} />
            {f.name}
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-[var(--ev-r-ctl)] border border-dashed border-ev-line-strong px-3 py-2 text-center font-round text-xs font-semibold text-ev-ink-2">
        Open it in Obsidian, grep it, or point an agent at it
      </div>
    </Frame>
  );
}
