import { useRef, type KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SegmentedOption<T extends string> = { value: T; label: string; icon?: LucideIcon };

export type SegmentedProps<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  size?: 'sm' | 'md';
  label: string;
  className?: string;
};

/** Settings only (e.g. HUD position). A raised thumb slides over a well track. */
export function Segmented<T extends string>({ value, onChange, options, size = 'md', label, className }: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const move = (e: KeyboardEvent, delta: number) => {
    e.preventDefault();
    const next = (index + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={cn('ev-segmented', className)} data-size={size}>
      <span
        className="ev-segmented-thumb"
        aria-hidden
        style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o, i) => {
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            tabIndex={o.value === value ? 0 : -1}
            className="ev-segmented-opt"
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(e, 1);
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(e, -1);
            }}
          >
            {Icon && <Icon size={13} strokeWidth={1.75} aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
