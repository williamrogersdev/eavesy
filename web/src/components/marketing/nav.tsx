'use client';

import { useEffect, useState } from 'react';
import { Link } from '@/components/ui/app-link';
import { usePathname } from '@/lib/next-compat/navigation';
import { Menu, X } from 'lucide-react';
import { PRIMARY_NAV } from './content';
import { DownloadButton } from './ui';
import { BrandMark } from '@/components/brand-mark';
import { cn } from '@/lib/utils';

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
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
    <header className="sticky top-0 z-50 px-4 pt-4">
      <div className="mx-auto flex max-w-6xl items-center justify-between rounded-2xl border border-white/10 bg-[#0c0c12]/70 px-4 py-2.5 backdrop-blur-xl sm:px-5">
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold tracking-tight text-white"
        >
          <BrandMark className="h-7 w-7" />
          Eavesy
        </Link>

        <nav className="hidden items-center gap-1 text-sm text-white/60 md:flex">
          {PRIMARY_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(pathname, item.href) ? 'page' : undefined}
              className={cn(
                'flex min-h-10 items-center rounded-lg px-3 transition hover:bg-white/5 hover:text-white',
                isActive(pathname, item.href) && 'bg-white/[0.04] text-white',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/sign-in"
            className="hidden rounded-lg px-3 py-1.5 text-sm text-white/70 transition hover:text-white sm:block"
          >
            Sign in
          </Link>
          <DownloadButton label="Download" className="hidden px-4 py-2 sm:inline-flex" />
          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            className="rounded-lg p-1.5 text-white/70 transition hover:bg-white/5 hover:text-white md:hidden"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileOpen}
            aria-controls="mobile-navigation"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div id="mobile-navigation" className="mx-auto mt-2 max-w-6xl rounded-2xl border border-white/10 bg-[#0c0c12]/95 p-3 shadow-2xl backdrop-blur-xl md:hidden">
          <nav aria-label="Mobile navigation" className="flex flex-col text-sm text-white/70">
            {PRIMARY_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className="flex min-h-11 items-center rounded-lg px-3 transition hover:bg-white/5 hover:text-white"
              >
                {item.label}
              </Link>
            ))}
            <div className="mt-3 flex flex-col gap-2 border-t border-white/10 pt-3">
              <Link
                href="/sign-in"
                onClick={() => setMobileOpen(false)}
                className="flex min-h-11 items-center rounded-lg px-3 transition hover:bg-white/5 hover:text-white"
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
