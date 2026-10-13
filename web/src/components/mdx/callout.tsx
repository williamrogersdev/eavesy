import type { ReactNode } from 'react';
import { Info, Lightbulb, AlertTriangle, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

type CalloutType = 'note' | 'tip' | 'warning' | 'privacy';

const STYLES: Record<
  CalloutType,
  { icon: typeof Info; ring: string; iconColor: string; label: string }
> = {
  note: {
    icon: Info,
    ring: 'border-sky-400/20 bg-sky-400/[0.06]',
    iconColor: 'text-sky-300',
    label: 'Note',
  },
  tip: {
    icon: Lightbulb,
    ring: 'border-accent/20 bg-accent/[0.06]',
    iconColor: 'text-accent',
    label: 'Tip',
  },
  warning: {
    icon: AlertTriangle,
    ring: 'border-amber-400/20 bg-amber-400/[0.06]',
    iconColor: 'text-amber-300',
    label: 'Heads up',
  },
  privacy: {
    icon: ShieldCheck,
    ring: 'border-emerald-400/20 bg-emerald-400/[0.06]',
    iconColor: 'text-emerald-300',
    label: 'Your data',
  },
};

export function Callout({
  type = 'note',
  title,
  children,
}: {
  type?: CalloutType;
  title?: string;
  children: ReactNode;
}) {
  const { icon: Icon, ring, iconColor, label } = STYLES[type];
  return (
    <div className={cn('my-6 flex gap-3 rounded-2xl border p-4', ring)}>
      <Icon className={cn('mt-0.5 h-5 w-5 flex-none', iconColor)} />
      <div className="min-w-0 [&>:first-child]:mt-0 [&>:last-child]:mb-0">
        <div className="mb-1 text-sm font-semibold text-white">
          {title ?? label}
        </div>
        <div className="text-sm leading-relaxed text-white/70">{children}</div>
      </div>
    </div>
  );
}
