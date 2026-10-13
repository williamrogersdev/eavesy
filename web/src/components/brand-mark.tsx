import { cn } from '@/lib/utils';

export function BrandMark({
  className,
  dotClassName,
}: {
  className?: string;
  dotClassName?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex items-center justify-center rounded-[28%] bg-[#111113]',
        className,
      )}
    >
      <span
        className={cn(
          'block aspect-square w-[38%] rounded-full bg-[var(--signal)]',
          dotClassName,
        )}
      />
    </span>
  );
}
