import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  selected: boolean;
  onClick: () => void;
  /** Shown only while selected (DESIGN.md §5: counts only when the filter is active). */
  count?: number;
  icon?: LucideIcon;
};

export function Chip({ selected, onClick, count, icon: Icon, className, children, type = 'button', ...rest }: ChipProps) {
  return (
    <button type={type} aria-pressed={selected} onClick={onClick} className={cn('ev-chip', className)} {...rest}>
      {Icon && <Icon size={13} strokeWidth={1.75} aria-hidden />}
      {children}
      {selected && count !== undefined && <span className="ev-chip-count">{count}</span>}
    </button>
  );
}
