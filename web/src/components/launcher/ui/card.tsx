import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type CardProps = {
  title?: ReactNode;
  children: ReactNode;
  /** Pad each child row (10/12). Off when rows bring their own padding. */
  inset?: boolean;
  className?: string;
};

/** Settings groups only: the one card-like container in the app (DESIGN.md §5). */
export function Card({ title, children, inset = false, className }: CardProps) {
  return (
    <section className={cn('ev-card-wrap', className)}>
      {title && <h3 className="ev-card-title">{title}</h3>}
      <div className="ev-card" data-inset={inset}>{children}</div>
    </section>
  );
}
