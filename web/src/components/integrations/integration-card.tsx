import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A group of integrations under one heading. */
export function IntegrationGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-round text-[13px] font-bold text-ev-ink-2">{title}</h2>
      <div className="divide-y divide-ev-line overflow-hidden rounded-[var(--ev-r-panel)] bg-ev-raised shadow-[0_0_0_0.5px_var(--ev-line-strong)]">
        {children}
      </div>
    </section>
  );
}

/** One thing Eavesy connects to: what it is, whether it's connected, and the button that changes that. */
export function IntegrationCard({
  icon,
  name,
  blurb,
  status,
  action,
  children,
}: {
  icon: ReactNode;
  name: string;
  blurb: string;
  /** A short state such as "Connected"; `tone` colours it. */
  status?: { text: string; tone: 'on' | 'warn' };
  action?: ReactNode;
  /** Details shown under the row: keys, endpoints, a field. */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--ev-r-ctl)] bg-ev-well text-ev-ink-2 [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:stroke-[1.75]">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-round text-sm font-bold text-ev-ink">
            <span className="truncate">{name}</span>
            {status ? (
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold',
                  status.tone === 'on' ? 'bg-ev-leaf-soft text-ev-leaf' : 'bg-ev-warn-soft text-ev-warn-ink',
                )}
              >
                {status.text}
              </span>
            ) : null}
          </p>
          <p className="truncate text-[13px] text-ev-ink-2" title={blurb}>{blurb}</p>
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}
