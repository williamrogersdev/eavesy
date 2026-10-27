import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** One setting: what it is on the left, its control on the right, an optional line of help under the name. */
export function Row({ label, hint, children, className }: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('ev-set-row', className)}>
      <div className="min-w-0 flex-1">
        <div className="ev-set-label">{label}</div>
        {hint && <div className="ev-set-hint">{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
  );
}
