import { Link } from '@/components/ui/app-link';
import { Apple } from 'lucide-react';
import { cn } from '@/lib/utils';

export const DOWNLOAD_HREF = '/download/mac?start=1';

export function DownloadButton({
  className,
  label = 'Download for Mac',
}: {
  className?: string;
  label?: string;
}) {
  return (
    <Link
      href={DOWNLOAD_HREF}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl bg-action px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-action/25 transition hover:bg-action-hover',
        className,
      )}
    >
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
    <Link
      href={href}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl bg-action px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-action/25 transition hover:bg-action-hover',
        className,
      )}
    >
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
        'inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-5 py-2.5 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.08]',
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium uppercase tracking-wider text-white/60">
      {children}
    </span>
  );
}
