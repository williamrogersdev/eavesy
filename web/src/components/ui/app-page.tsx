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
    'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
    size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
    variant === 'primary' && 'bg-action text-white hover:bg-action-hover',
    variant === 'secondary' && 'border border-border bg-background hover:bg-muted',
    variant === 'ghost' && 'text-muted-foreground hover:bg-muted hover:text-foreground',
    variant === 'danger' && 'bg-danger text-white hover:opacity-90',
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
        <h1 className="text-xl font-semibold tracking-[-0.02em]">{title}</h1>
        {description ? (
          <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{description}</p>
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
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border px-5 py-10 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
        {icon}
      </span>
      <h2 className="mt-3 text-sm font-semibold">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
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
        'rounded-md border px-3 py-2 text-sm',
        tone === 'danger' && 'border-danger/25 bg-danger-soft text-danger',
        tone === 'info' && 'border-border bg-muted/45 text-foreground',
        tone === 'success' && 'border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
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
    <section id={id} className={cn('flex scroll-mt-6 flex-col gap-3 border-t border-border pt-5 first:border-t-0 first:pt-0', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
