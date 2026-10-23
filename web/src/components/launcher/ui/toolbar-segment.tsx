import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Kbd } from './kbd';

export type ToolbarSegmentProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: LucideIcon;
  label: string;
  /** Tooltip, e.g. "Records both sides of a call". */
  hint?: string;
  kbd?: string;
};

/**
 * One of the four equal capture segments on the toolbar shelf (DESIGN.md §5).
 * While a capture runs the whole shelf becomes the live bar, so a segment never
 * shows Stop itself.
 */
export const ToolbarSegment = forwardRef<HTMLButtonElement, ToolbarSegmentProps>(function ToolbarSegment(
  { icon: Icon, label, hint, kbd, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={hint}
      aria-label={hint ? `${label}: ${hint}` : label}
      className={cn('ev-seg', className)}
      {...rest}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden />
      <span className="ev-seg-label">{label}</span>
      {kbd && <Kbd keys={kbd} />}
    </button>
  );
});

export function ToolbarShelf({ className, children, label = 'Capture' }: { className?: string; children: ReactNode; label?: string }) {
  return (
    <div role="toolbar" aria-label={label} className={cn('ev-shelf', className)}>
      {children}
    </div>
  );
}
