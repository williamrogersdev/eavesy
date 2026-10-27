import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const WIDTHS = {
  compact: 'max-w-2xl',
  reading: 'max-w-4xl',
  wide: 'max-w-6xl',
} as const;

export function appButton(
  variant: 'primary' | 'secondary' | 'ghost' | 'danger' = 'secondary',
  size: 'sm' | 'md' = 'md',
) {
  return cn(
    'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full font-round font-bold transition duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
    size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-9 px-4 text-[13.5px]',
    variant === 'primary' && 'bg-ev-coat text-ev-on-coat shadow-[var(--ev-e-2)] hover:bg-ev-coat-hover',
    variant === 'secondary' && 'text-ev-ink shadow-[inset_0_0_0_1px_var(--ev-line-strong)] hover:bg-[var(--ev-hover)]',
    variant === 'ghost' && 'text-ev-ink-2 hover:bg-[var(--ev-hover)] hover:text-ev-ink',
    variant === 'danger' && 'bg-ev-warn-soft text-ev-warn-ink hover:bg-[color-mix(in_srgb,var(--ev-warn-soft)_80%,var(--ev-warn-ink))]',
  );
}

export function AppPage({
  children,
  className,
  width = 'wide',
}: {
  children: ReactNode;
  className?: string;
  width?: keyof typeof WIDTHS;
}) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full flex-col gap-5 px-4 pb-12 pt-4 sm:px-6 sm:pt-6 lg:px-8',
        WIDTHS[width],
        className,
      )}
    >
      {children}
    </div>
  );
}

export function AppPageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className="font-round text-[26px] font-extrabold tracking-tight text-ev-ink">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-ev-ink-2">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function AppEmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-[var(--ev-r-panel)] bg-ev-well px-5 py-12 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-ev-raised text-ev-ink-2 shadow-[var(--ev-e-2)] [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:stroke-[1.75]">
        {icon}
      </span>
      <h2 className="mt-3 font-round text-[15px] font-bold text-ev-ink">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-ev-ink-2">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function AppAlert({
  children,
  tone = 'danger',
}: {
  children: ReactNode;
  tone?: 'danger' | 'info' | 'success';
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'rounded-[var(--ev-r-pop)] px-3.5 py-2.5 text-sm',
        tone === 'danger' && 'bg-ev-warn-soft text-ev-warn-ink',
        tone === 'info' && 'bg-ev-well text-ev-ink',
        tone === 'success' && 'bg-ev-leaf-soft text-ev-leaf',
      )}
    >
      {children}
    </div>
  );
}

export function AppSection({
  id,
  title,
  description,
  action,
  children,
  className,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn('flex scroll-mt-6 flex-col gap-3 border-t border-ev-line pt-5 first:border-t-0 first:pt-0', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-round text-[15px] font-bold text-ev-ink">{title}</h2>
          {description ? <p className="mt-0.5 text-[13px] text-ev-ink-2">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
