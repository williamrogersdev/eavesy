import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Loader2, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Kbd } from './kbd';

export type ButtonVariant = 'primary' | 'ghost' | 'quiet' | 'outline' | 'danger-rec';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: LucideIcon;
  /** Shortcut shown after the label, e.g. "⌘," */
  kbd?: string;
  loading?: boolean;
};

/** DESIGN.md §8. `danger-rec` is only for stopping a live recording. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'md', icon: Icon, kbd, loading = false, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const iconSize = size === 'sm' ? 14 : 16;
  return (
    <button
      ref={ref}
      type={type}
      className={cn('ev-btn', className)}
      data-variant={variant}
      data-size={size}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Loader2 size={iconSize} strokeWidth={1.75} className="ev-spin" aria-hidden />
      ) : (
        Icon && <Icon size={iconSize} strokeWidth={1.75} aria-hidden />
      )}
      {children}
      {kbd && <Kbd keys={kbd} />}
    </button>
  );
});
