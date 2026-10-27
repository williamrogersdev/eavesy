import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Eavesy's speech bubble. Only for its own voice: empty states, onboarding, first-run tips. */
export function Bubble({ children, tail, className }: { children: ReactNode; tail: 'left' | 'top' | 'bottom'; className?: string }) {
  return (
    <div className={cn('ev-bubble', className)} data-tail={tail}>
      {children}
    </div>
  );
}
