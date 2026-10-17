import { forwardRef, type ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  /** Required: the aria-label and the tooltip. */
  label: string;
  icon: LucideIcon;
  size?: 24 | 28;
  tone?: 'default' | 'rec';
  pressed?: boolean;
  /** Use a filled glyph (live states only: stop, play). */
  filled?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon: Icon, size = 28, tone = 'default', pressed, filled = false, className, type = 'button', title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      className={cn('ev-ib', className)}
      data-size={size}
      data-tone={tone}
      {...rest}
    >
      <Icon
        size={size === 24 ? 14 : 16}
        strokeWidth={1.75}
        fill={filled ? 'currentColor' : 'none'}
        aria-hidden
      />
    </button>
  );
});
