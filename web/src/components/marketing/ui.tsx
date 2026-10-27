import { Link } from '@/components/ui/app-link';
import { Apple } from 'lucide-react';
import { cn } from '@/lib/utils';

export const DOWNLOAD_HREF = '/download/mac?start=1';

const PRIMARY =
  'inline-flex items-center justify-center gap-2 rounded-full bg-ev-coat px-5 py-2.5 font-round text-sm font-bold text-ev-on-coat shadow-[var(--ev-e-2)] transition duration-150 hover:bg-ev-coat-hover active:scale-[0.97]';

export function DownloadButton({
  className,
  label = 'Download for Mac',
}: {
  className?: string;
  label?: string;
}) {
  return (
    <Link href={DOWNLOAD_HREF} className={cn(PRIMARY, className)}>
      <Apple className="h-4 w-4" />
      {label}
    </Link>
  );
}

export function GradientButton({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link href={href} className={cn(PRIMARY, className)}>
      {children}
    </Link>
  );
}

export function SecondaryButton({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 font-round text-sm font-bold text-ev-ink shadow-[inset_0_0_0_1px_var(--ev-line-strong)] transition duration-150 hover:bg-ev-well active:scale-[0.97]',
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-ev-coat-soft px-3 py-1 font-round text-xs font-bold text-ev-coat">
      {children}
    </span>
  );
}
