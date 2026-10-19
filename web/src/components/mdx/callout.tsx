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
    ring: 'border-ev-line bg-ev-well',
    iconColor: 'text-ev-ink-2',
    label: 'Note',
  },
  tip: {
    icon: Lightbulb,
    ring: 'border-ev-slate/40 bg-ev-slate-soft',
    iconColor: 'text-ev-slate',
    label: 'Tip',
  },
  warning: {
    icon: AlertTriangle,
    ring: 'border-ev-warn-ink/30 bg-ev-warn-soft',
    iconColor: 'text-ev-warn-ink',
    label: 'Heads up',
  },
  privacy: {
    icon: ShieldCheck,
    ring: 'border-ev-leaf/30 bg-ev-leaf-soft',
    iconColor: 'text-ev-leaf',
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
        <div className="mb-1 text-sm font-semibold text-ev-ink">
          {title ?? label}
        </div>
        <div className="text-sm leading-relaxed text-ev-ink">{children}</div>
      </div>
    </div>
  );
}
