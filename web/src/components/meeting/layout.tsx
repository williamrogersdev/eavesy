'use client';

import { cn } from '@/lib/utils';

export function Section({
  title,
  icon,
  action,
  children,
  className,
  flush = false,
}: {
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Let the body run edge to edge; only the heading keeps the card padding. */
  flush?: boolean;
}) {
  return (
    <section
      className={cn(
        'rounded-[var(--ev-r-panel)] bg-ev-raised shadow-[0_0_0_1px_var(--ev-line),var(--ev-e-2)]',
        !flush && 'p-4 sm:p-5',
        className,
      )}
    >
      <div className={cn('flex min-h-8 flex-wrap items-center justify-between gap-2', flush ? 'px-4 pb-1 pt-4' : 'mb-3')}>
        <h2 className="flex items-center gap-2 font-round text-[15px] font-extrabold text-ev-ink">
          {icon}
          {title}
        </h2>
        {action}
      </div>
      <div>{children}</div>
    </section>
  );
}

export function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1.5 font-round text-[13px] font-bold text-ev-ink-2">{children}</h3>;
}

export function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-ev-ink-2">
      {children}
    </div>
  );
}
