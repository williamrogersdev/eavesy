import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
};

export function Switch({ checked, onCheckedChange, label, hint, disabled, className }: SwitchProps) {
  const id = useId();
  return (
    <div className={cn('ev-switch-row', className)}>
      <div className="ev-switch-text">
        <div id={`${id}-l`} className="ev-switch-label">{label}</div>
        {hint && <div id={`${id}-h`} className="ev-switch-hint">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={hint ? `${id}-h` : undefined}
        disabled={disabled}
        className="ev-switch"
        onClick={() => onCheckedChange(!checked)}
      />
    </div>
  );
}
