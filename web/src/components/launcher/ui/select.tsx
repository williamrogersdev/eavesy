import { ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SelectOption<T extends string> = { value: T; label: string };

/** A compact pop-up menu for a settings row: the choice reads at a glance, the list opens on click. */
export function Select<T extends string>({ value, onChange, options, label, disabled, className }: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('ev-select', className)}>
      <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <ChevronsUpDown className="ev-select-icon" aria-hidden />
    </span>
  );
}
