import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Square, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Kbd } from './kbd';

export type ToolbarSegmentProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: LucideIcon;
  label: string;
  /** Tooltip, e.g. "Records both sides of a call". */
  hint?: string;
  kbd?: string;
  /** This capture is running: render Stop + elapsed. The panel's only red control. */
  active?: boolean;
  /** Elapsed text shown while active, e.g. "0:42". */
  elapsed?: string;
  /** Another capture is running. */
  dimmed?: boolean;
};

/** One of the four equal capture segments on the toolbar shelf (DESIGN.md §5). */
export const ToolbarSegment = forwardRef<HTMLButtonElement, ToolbarSegmentProps>(function ToolbarSegment(
  { icon: Icon, label, hint, kbd, active = false, elapsed, dimmed = false, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={active ? `Stop ${label.toLowerCase()}` : hint}
      aria-label={active ? `Stop ${label.toLowerCase()}${elapsed ? `, ${elapsed}` : ''}` : hint ? `${label}: ${hint}` : label}
      className={cn('ev-seg', className)}
      data-active={active}
      data-dimmed={dimmed}
      {...rest}
    >
      {active ? (
        <>
          <Square size={12} strokeWidth={0} fill="currentColor" aria-hidden />
          <span className="ev-seg-label">Stop</span>
          {elapsed && <span className="ev-seg-time">{elapsed}</span>}
        </>
      ) : (
        <>
          <Icon size={14} strokeWidth={1.75} aria-hidden />
          <span className="ev-seg-label">{label}</span>
          {kbd && <Kbd keys={kbd} />}
        </>
      )}
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
