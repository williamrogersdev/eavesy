'use client';

import { useEffect, useRef } from 'react';
import { BookOpen, ChevronDown } from 'lucide-react';
import { Link } from '@/components/ui/app-link';
import { usePathname } from '@/lib/next-compat/navigation';
import { GithubMark } from '@/components/github-mark';
import { cn } from '@/lib/utils';
import { categoryMeta } from '@/lib/docs-meta';
import { siteConfig } from '@/lib/site';

export interface DocNavGroup {
  category: string;
  items: { slug: string; title: string }[];
}

function NavList({ groups, pathname }: { groups: DocNavGroup[]; pathname: string }) {
  return (
    <div className="flex flex-col gap-6 text-sm">
      <Link
        href="/docs"
        aria-current={pathname === '/docs' ? 'page' : undefined}
        className={cn(
          'flex min-h-9 items-center gap-2 rounded-xl px-3 font-round font-bold transition',
          pathname === '/docs'
            ? 'bg-ev-slate-soft text-ev-slate'
            : 'text-ev-ink hover:bg-ev-well',
        )}
      >
        <BookOpen className="h-4 w-4" />
        Overview
      </Link>
      {groups.map((group) => {
        const { icon: Icon } = categoryMeta(group.category);
        return (
          <div key={group.category}>
            <div className="mb-1.5 flex items-center gap-2 px-3 font-round text-[13px] font-bold text-ev-ink">
              <Icon className="h-3.5 w-3.5 text-ev-ink-3" />
              {group.category}
            </div>
            <ul className="flex flex-col gap-px">
              {group.items.map((item) => {
                const href = `/docs/${item.slug}`;
                const active = pathname === href;
                return (
                  <li key={item.slug}>
                    <Link
                      href={href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex min-h-8 items-center rounded-xl py-1.5 pl-[2.1rem] pr-3 transition',
                        active
                          ? 'bg-ev-slate-soft font-semibold text-ev-slate'
                          : 'text-ev-ink-2 hover:bg-ev-well hover:text-ev-ink',
                      )}
                    >
                      {item.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <a
        href={siteConfig.github}
        className="flex min-h-9 items-center gap-2 rounded-xl border-t border-ev-line px-3 pt-4 text-ev-ink-2 transition hover:text-ev-ink"
      >
        <GithubMark className="h-4 w-4" />
        Eavesy on GitHub
      </a>
    </div>
  );
}

export function DocsSidebar({ groups }: { groups: DocNavGroup[] }) {
  const pathname = usePathname();
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const current = groups
    .flatMap((g) => g.items)
    .find((item) => pathname === `/docs/${item.slug}`);

  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
  }, [pathname]);

  return (
    <nav aria-label="Documentation">
      <details
        ref={detailsRef}
        className="group rounded-2xl bg-ev-raised shadow-[inset_0_0_0_1px_var(--ev-line)] lg:hidden"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 font-round text-sm font-bold text-ev-ink [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-2">
            <BookOpen className="h-4 w-4 flex-none text-ev-ink-3" />
            <span className="truncate">{current ? current.title : 'Browse the docs'}</span>
          </span>
          <ChevronDown className="h-4 w-4 flex-none text-ev-ink-3 transition group-open:rotate-180" />
        </summary>
        <div className="border-t border-ev-line p-2 pb-3">
          <NavList groups={groups} pathname={pathname} />
        </div>
      </details>
      <div className="hidden lg:block">
        <NavList groups={groups} pathname={pathname} />
      </div>
    </nav>
  );
}
