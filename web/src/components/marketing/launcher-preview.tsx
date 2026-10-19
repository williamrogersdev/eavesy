import { AudioLines, Camera, Clapperboard, Copy, Plus, Search, StickyNote, Users, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Kbd, Mascot, ToolbarSegment, ToolbarShelf } from '@/components/launcher/ui';
import { cn } from '@/lib/utils';

const CHIPS = ['All', 'Voice', 'Meetings', 'Screens', 'Notes'];

export function LauncherPreview({ className }: { className?: string }) {
  return (
    <div aria-hidden inert className={cn('relative mx-auto w-full max-w-[420px] select-none', className)}>
      <div className="overflow-hidden rounded-[var(--ev-r-panel)] bg-ev-paper text-left shadow-[var(--ev-e-3)]">
        <div className="flex h-11 items-center gap-2 px-3.5">
          <span className="grid h-[18px] w-[18px] place-items-center rounded-full text-ev-ink-3">
            <X size={11} strokeWidth={2} />
          </span>
          <Mascot size={20} state="idle" />
          <span className="font-round text-[13.5px] font-[650] text-ev-ink">Eavesy</span>
          <span className="ml-auto grid h-6 w-6 place-items-center rounded-full bg-ev-honey-soft font-round text-[11px] font-bold text-ev-honey-ink">
            W
          </span>
        </div>

        <div className="px-3.5">
          <ToolbarShelf>
            <ToolbarSegment icon={AudioLines} label="Talk" kbd="fn" tabIndex={-1} />
            <ToolbarSegment icon={Users} label="Meeting" tabIndex={-1} />
            <ToolbarSegment icon={Camera} label="Screenshot" tabIndex={-1} />
            <ToolbarSegment icon={Clapperboard} label="Video" tabIndex={-1} />
          </ToolbarShelf>

          <div className="mt-2.5 flex h-8 items-center gap-2 rounded-[var(--ev-r-ctl)] bg-ev-well px-2.5 font-round text-[13px] text-ev-ink-3">
            <Search size={14} strokeWidth={1.75} />
            Search captures
            <Kbd keys="/" className="ml-auto" />
          </div>

          <div className="mt-2.5 flex gap-1.5 overflow-hidden">
            {CHIPS.map((c, i) => (
              <span key={c} className="ev-chip" aria-pressed={i === 0}>
                {c}
              </span>
            ))}
          </div>
        </div>

        <div className="relative mt-3 pb-16">
          <div className="px-3.5 font-round text-xs font-bold text-ev-ink-2">Today</div>
          <div className="relative mt-1">
            <span className="absolute bottom-6 left-[22px] top-4 border-l border-dotted border-ev-line-strong" />
            <Row icon={AudioLines} kind="Voice note" meta="0:42" time="9:41" hovered>
              Remind Sam the deck goes out Thursday, and ask whether the pricing slide still needs the old numbers.
            </Row>
            <Row icon={Camera} kind="Screenshot" time="9:12">
              <ScreenshotThumb />
            </Row>
            <Row icon={StickyNote} kind="Note" time="8:57">
              Bug: the export button is greyed out after switching workspaces.
            </Row>
          </div>

          <div className="absolute inset-x-2.5 bottom-2.5 flex h-10 items-center gap-1 rounded-[var(--ev-r-pop)] bg-ev-well px-1.5 font-round text-[13px] text-ev-ink-3">
            <span className="grid h-7 w-7 place-items-center rounded-[var(--ev-r-ctl)]">
              <Plus size={16} strokeWidth={1.75} />
            </span>
            Paste, drop a file, or jot a note…
            <Kbd keys="⌘V" className="ml-auto mr-1" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  icon: Icon,
  kind,
  meta,
  time,
  hovered = false,
  children,
}: {
  icon: LucideIcon;
  kind: string;
  meta?: string;
  time: string;
  hovered?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('relative px-3.5 py-2.5', hovered && 'bg-[var(--ev-hover)]')}>
      <div className="flex items-center gap-2 font-round text-[13px] font-[550]">
        <span className="relative grid h-5 w-5 place-items-center rounded-full bg-ev-paper text-ev-ink-2">
          <Icon size={14} strokeWidth={1.75} />
        </span>
        <span className="text-ev-ink">{kind}</span>
        {meta && <span className="tabular-nums text-ev-ink-3">· {meta}</span>}
        <span className="ml-auto text-[11.5px] tabular-nums text-ev-ink-3">{time}</span>
        {hovered && (
          <span className="absolute right-12 top-1.5 flex gap-0.5 rounded-[var(--ev-r-ctl)] bg-ev-raised p-0.5 shadow-[var(--ev-e-2)]">
            <span className="grid h-6 w-6 place-items-center text-ev-ink-2">
              <Copy size={13} strokeWidth={1.75} />
            </span>
          </span>
        )}
      </div>
      <div className="mt-1 pl-7 text-[13.5px] leading-5 text-ev-ink">{children}</div>
    </div>
  );
}

function ScreenshotThumb() {
  return (
    <div className="h-[92px] w-[160px] overflow-hidden rounded-[var(--ev-r-media)] bg-ev-raised p-2 shadow-[0_0_0_1px_var(--ev-line),var(--ev-e-2)]">
      <div className="h-2 w-16 rounded-full bg-ev-line-strong" />
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <div className="h-9 rounded bg-ev-slate-soft" />
        <div className="h-9 rounded bg-ev-honey-soft" />
        <div className="h-9 rounded bg-ev-well" />
      </div>
      <div className="mt-2 h-1.5 w-24 rounded-full bg-ev-line" />
      <div className="mt-1 h-1.5 w-14 rounded-full bg-ev-line" />
    </div>
  );
}

const LEVELS = [0.35, 0.7, 0.5, 0.95, 0.6, 0.8, 0.45, 0.65, 0.3];

/** The floating dictation bar (DESIGN.md §5 HUD): glass, mascot with the porch light on, timer. */
export function HudPreview({ className, words }: { className?: string; words?: [string, string] }) {
  return (
    <div aria-hidden className={cn('w-[300px] select-none', className)}>
      <div className="flex h-[34px] items-center gap-2 rounded-full border border-[var(--ev-hud-line)] bg-[var(--ev-hud)] px-2 text-[var(--ev-hud-ink)] shadow-[var(--ev-e-3)] backdrop-blur-[30px] backdrop-saturate-[160%]">
        <Mascot size={18} state="listening" level={0.6} recording />
        <span className="font-round text-[12.5px] font-semibold">Listening</span>
        <span className="font-round text-[12.5px] tabular-nums text-[var(--ev-hud-ink-2)]">0:07</span>
        <span className="ml-1 flex h-3.5 items-center gap-[2px]">
          {LEVELS.map((h, i) => (
            <i
              key={i}
              className="animate-eq block w-[2.5px] rounded-full bg-[var(--ev-hud-ink-2)]"
              style={{ height: `${h * 100}%`, animationDelay: `${i * 90}ms` }}
            />
          ))}
        </span>
        <span className="ml-auto grid h-6 w-6 place-items-center rounded-full bg-[rgb(255_240_220/0.1)]">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-ev-rec" />
        </span>
      </div>
      {words && (
        <div className="mx-3 mt-1.5 rounded-[var(--ev-r-sheet)] border border-[var(--ev-hud-line)] bg-[var(--ev-hud)] px-3.5 py-2.5 text-[13.5px] leading-[19px] text-[var(--ev-hud-ink)] shadow-[var(--ev-e-3)] backdrop-blur-[30px]">
          {words[0]} <span className="text-[var(--ev-hud-ink-2)]">{words[1]}</span>
          <span className="ml-0.5 inline-block h-3.5 w-px translate-y-0.5 animate-recording-pulse bg-[var(--ev-hud-ink)]" />
        </div>
      )}
    </div>
  );
}
