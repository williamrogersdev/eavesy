'use client';

import { Link } from '@/components/ui/app-link';
import { usePathname } from '@/lib/next-compat/navigation';
import { BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { categoryMeta } from '@/lib/docs-meta';

export interface DocNavGroup {
  category: string;
  items: { slug: string; title: string }[];
}

export function DocsSidebar({ groups }: { groups: DocNavGroup[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-7 text-sm">
      <Link
        href="/docs"
        className={cn(
          'inline-flex items-center gap-2 font-semibold transition hover:text-ev-ink',
          pathname === '/docs' ? 'text-ev-ink' : 'text-ev-ink-2',
        )}
      >
        <BookOpen className="h-4 w-4 text-ev-ink-2" />
        Overview
      </Link>
      {groups.map((group) => {
        const { icon: Icon } = categoryMeta(group.category);
        return (
        <div key={group.category}>
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-ev-ink-2">
            <Icon className="h-3.5 w-3.5" />
            {group.category}
          </div>
          <ul className="flex flex-col gap-0.5 border-l border-ev-line">
            {group.items.map((item) => {
              const href = `/docs/${item.slug}`;
              const active = pathname === href;
              return (
                <li key={item.slug}>
                  <Link
                    href={href}
                    className={cn(
                      '-ml-px block border-l-2 py-1.5 pl-4 transition',
                      active
                        ? 'border-ev-slate text-ev-ink'
                        : 'border-transparent text-ev-ink-2 hover:border-ev-line-strong hover:text-ev-ink',
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
    </nav>
  );
}
