'use client';

import { useEffect, useState } from 'react';
import type { TocItem } from '@/lib/toc';
import { cn } from '@/lib/utils';

export function DocToc({ items }: { items: TocItem[] }) {
  const [activeId, setActiveId] = useState<string>('');

  useEffect(() => {
    if (items.length === 0) return;
    const headings = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-96px 0px -70% 0px', threshold: 0 },
    );

    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [items]);

  if (items.length < 2) return null;

  return (
    <nav aria-label="On this page" className="text-sm">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-white/50">
        On this page
      </div>
      <ul className="flex flex-col gap-0.5 border-l border-white/[0.08]">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                className={cn(
                  '-ml-px block border-l-2 py-1 transition',
                  item.depth === 3 ? 'pl-7' : 'pl-4',
                  active
                    ? 'border-accent text-white'
                    : 'border-transparent text-white/55 hover:border-white/30 hover:text-white/80',
                )}
              >
                {item.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
