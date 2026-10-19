import { Mascot, type MascotState } from '@/components/launcher/ui';
import { cn } from '@/lib/utils';

/** The Eavesy mark: the mascot itself (desktop/DESIGN.md §3). Decorative. */
export function BrandMark({
  size = 28,
  state = 'idle',
  className,
}: {
  size?: number;
  state?: MascotState;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn('flex w-fit shrink-0', className)}>
      <Mascot size={size} state={state} />
    </span>
  );
}
