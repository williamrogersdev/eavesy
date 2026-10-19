'use client';

import { useEffect, useState } from 'react';
import { Link } from '@/components/ui/app-link';
import { usePathname } from '@/lib/next-compat/navigation';
import { Menu, X } from 'lucide-react';
import { Mascot } from '@/components/launcher/ui';
import { PRIMARY_NAV } from './content';
import { DownloadButton } from './ui';
import { cn } from '@/lib/utils';

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn('flex items-center gap-2 font-round text-[17px] font-extrabold text-ev-ink', className)}>
      <Mascot size={28} state="idle" />
      Eavesy
    </Link>
  );
}

export function Nav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => setMobileOpen(false), [pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  return (
    <header className="sticky top-0 z-50 px-4 pt-3">
      <div className="mx-auto flex max-w-6xl items-center justify-between rounded-full bg-[color-mix(in_srgb,var(--ev-paper)_82%,transparent)] py-2 pl-4 pr-2 shadow-[var(--ev-e-3)] backdrop-blur-xl backdrop-saturate-150">
        <Wordmark />

        <nav className="hidden items-center gap-1 font-round text-sm font-semibold text-ev-ink-2 md:flex">
          {PRIMARY_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(pathname, item.href) ? 'page' : undefined}
              className={cn(
                'flex min-h-9 items-center rounded-full px-3.5 transition hover:bg-ev-well hover:text-ev-ink',
                isActive(pathname, item.href) && 'bg-ev-slate-soft text-ev-slate hover:bg-ev-slate-soft hover:text-ev-slate',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <Link
            href="/sign-in"
            className="hidden min-h-9 items-center rounded-full px-3.5 font-round text-sm font-semibold text-ev-ink-2 transition hover:bg-ev-well hover:text-ev-ink sm:flex"
          >
            Sign in
          </Link>
          <DownloadButton label="Download" className="hidden px-4 py-2 sm:inline-flex" />
          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            className="grid h-9 w-9 place-items-center rounded-full text-ev-ink-2 transition hover:bg-ev-well hover:text-ev-ink md:hidden"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileOpen}
            aria-controls="mobile-navigation"
          >
            {mobileOpen ? <X className="h-5 w-5" strokeWidth={1.75} /> : <Menu className="h-5 w-5" strokeWidth={1.75} />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div id="mobile-navigation" className="mx-auto mt-2 max-w-6xl rounded-[20px] bg-ev-raised p-2 shadow-[var(--ev-e-3)] md:hidden">
          <nav aria-label="Mobile navigation" className="flex flex-col font-round text-[15px] font-semibold text-ev-ink">
            {PRIMARY_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className="flex min-h-11 items-center rounded-xl px-3 transition hover:bg-ev-well"
              >
                {item.label}
              </Link>
            ))}
            <div className="mt-2 flex flex-col gap-2 border-t border-ev-line pt-2">
              <Link
                href="/sign-in"
                onClick={() => setMobileOpen(false)}
                className="flex min-h-11 items-center rounded-xl px-3 transition hover:bg-ev-well"
              >
                Sign in
              </Link>
              <DownloadButton className="min-h-11 px-4 py-2" />
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
