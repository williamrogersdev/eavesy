import { Link } from '@/components/ui/app-link';
import { ArrowLeft, ArrowRight } from 'lucide-react';

export interface PagerLink {
  slug: string;
  title: string;
}

export function DocPager({
  prev,
  next,
}: {
  prev?: PagerLink;
  next?: PagerLink;
}) {
  if (!prev && !next) return null;
  return (
    <nav className="mt-14 grid gap-3 border-t border-white/[0.08] pt-8 sm:grid-cols-2">
      {prev ? (
        <Link
          href={`/docs/${prev.slug}`}
          className="group flex flex-col rounded-2xl border border-white/10 bg-white/[0.02] p-4 transition hover:border-white/20 hover:bg-white/[0.04]"
        >
          <span className="flex items-center gap-1.5 text-xs text-white/50">
            <ArrowLeft className="h-3.5 w-3.5" /> Previous
          </span>
          <span className="mt-1 font-medium text-white/85 group-hover:text-white">
            {prev.title}
          </span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={`/docs/${next.slug}`}
          className="group flex flex-col rounded-2xl border border-white/10 bg-white/[0.02] p-4 text-right transition hover:border-white/20 hover:bg-white/[0.04] sm:items-end"
        >
          <span className="flex items-center gap-1.5 text-xs text-white/50">
            Next <ArrowRight className="h-3.5 w-3.5" />
          </span>
          <span className="mt-1 font-medium text-white/85 group-hover:text-white">
            {next.title}
          </span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
