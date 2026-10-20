'use client';

import {
  Apple,
  ChevronsUpDown,
  FolderOpen,
  LayoutGrid,
  LogOut,
  Menu,
  Mic,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { GithubMark } from '@/components/github-mark';
import { DropButton } from '@/components/drops/drop-button';
import { DropsProvider } from '@/components/drops/drops-provider';
import { CaptureBar } from '@/components/recorder/capture-bar';
import { KindIcon } from '@/components/library/kind';
import { appButton } from '@/components/ui/app-page';
import { Link } from '@/components/ui/app-link';
import { type LibItem, useLibraryItems } from '@/lib/api/use-library';
import { useMe } from '@/lib/api/use-me';
import { isDesktop } from '@/lib/desktop/bridge';
import { usePathname, useRouter } from '@/lib/next-compat/navigation';
import { useSignOut } from '@/lib/use-sign-out';
import { siteConfig } from '@/lib/site';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/app', label: 'Library', icon: LayoutGrid },
  { href: '/app/projects', label: 'Projects', icon: FolderOpen },
  { href: '/app/search', label: 'Search', icon: Search },
  { href: '/app/settings', label: 'Settings', icon: Settings },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => setMobileNavOpen(false), [pathname]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    drawerCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileNavOpen(false);
        requestAnimationFrame(() => menuButtonRef.current?.focus());
        return;
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileNavOpen]);

  const closeMobileNav = () => {
    setMobileNavOpen(false);
    requestAnimationFrame(() => menuButtonRef.current?.focus());
  };

  return (
    <DropsProvider>
      <div className="flex h-dvh min-h-[560px] w-full overflow-hidden bg-ev-paper">
        <a
          href="#app-content"
          className="fixed left-4 top-3 z-[70] -translate-y-20 rounded-full bg-ev-coat px-3 py-2 font-round text-sm font-bold text-ev-on-coat transition focus:translate-y-0"
        >
          Skip to content
        </a>

        <div className="hidden h-full w-[232px] shrink-0 lg:block">
          <Sidebar />
        </div>

        {mobileNavOpen ? (
          <div className="fixed inset-0 z-[60] lg:hidden">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={closeMobileNav}
              className="absolute inset-0 cursor-default bg-[rgb(42_34_51/0.38)] backdrop-blur-[2px]"
            />
            <div
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Main navigation"
              className="relative h-full w-[min(86vw,320px)] animate-fade-up"
            >
              <Sidebar onNavigate={() => setMobileNavOpen(false)} />
              <button
                ref={drawerCloseRef}
                type="button"
                aria-label="Close navigation"
                onClick={closeMobileNav}
                className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full text-ev-ink-2 hover:bg-[var(--ev-hover)] hover:text-ev-ink"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <MobileHeader menuButtonRef={menuButtonRef} onMenu={() => setMobileNavOpen(true)} />
          <header className="relative flex h-14 shrink-0 items-center gap-2 border-b border-ev-line bg-ev-paper px-3 sm:px-5">
            <TopSearch />
            <DropButton />
            <CaptureBar />
          </header>
          <main id="app-content" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {children}
          </main>
        </div>
      </div>
    </DropsProvider>
  );
}

function MobileHeader({
  menuButtonRef,
  onMenu,
}: {
  menuButtonRef: React.RefObject<HTMLButtonElement | null>;
  onMenu: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-ev-line px-3 lg:hidden">
      <button
        ref={menuButtonRef}
        type="button"
        onClick={onMenu}
        aria-label="Open navigation"
        className="grid h-9 w-9 place-items-center rounded-full text-ev-ink-2 hover:bg-[var(--ev-hover)] hover:text-ev-ink"
      >
        <Menu className="h-5 w-5" />
      </button>
      <Link href="/app" className="flex items-center gap-2 font-round text-[15px] font-extrabold text-ev-ink">
        <BrandMark size={28} />
        Eavesy
      </Link>
      <Link
        href="/app/record"
        aria-label="New recording"
        className="grid h-9 w-9 place-items-center rounded-full bg-ev-coat text-ev-on-coat hover:bg-ev-coat-hover"
      >
        <Mic className="h-4 w-4" />
      </Link>
    </header>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const desktop = isDesktop();
  const { items, loading } = useLibraryItems();
  const recent = items.slice(0, 10);

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-r border-ev-line bg-ev-well shadow-[var(--ev-e-3)] lg:shadow-none">
      <div className="px-4 py-4">
        <Link
          href="/app"
          onClick={onNavigate}
          className="flex w-fit items-center gap-2 font-round text-[16px] font-extrabold text-ev-ink"
        >
          <BrandMark size={30} />
          <span>Eavesy</span>
        </Link>
      </div>

      <div className="px-3">
        <Link
          href="/app/record"
          onClick={onNavigate}
          className={cn(appButton('primary'), 'w-full')}
        >
          <Mic className="h-4 w-4" strokeWidth={2} />
          New recording
        </Link>
      </div>

      <PrimaryNavigation onNavigate={onNavigate} />

      <div className="mt-4 flex min-h-0 flex-1 flex-col pt-1">
        <div className="flex items-center justify-between px-4 pb-2">
          <span className="font-round text-xs font-bold text-ev-ink-2">Recent</span>
          <Link
            href="/app"
            onClick={onNavigate}
            className="rounded-full px-2 py-0.5 font-round text-xs font-semibold text-ev-ink-2 hover:bg-[var(--ev-hover)] hover:text-ev-ink"
          >
            View all
          </Link>
        </div>
        <nav aria-label="Recent recordings" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {loading && recent.length === 0 ? (
            <div className="space-y-1 px-1 py-1" aria-label="Loading recent items">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="h-8 animate-pulse rounded-[var(--ev-r-ctl)] bg-ev-paper/70" />
              ))}
            </div>
          ) : recent.length === 0 ? (
            <p className="px-2 py-2 text-xs leading-relaxed text-ev-ink-2">
              Your newest recordings and captures will appear here.
            </p>
          ) : (
            recent.map((item) => (
              <RecentRow key={`${item.kind}-${item.id}`} item={item} onNavigate={onNavigate} />
            ))
          )}
        </nav>
      </div>

      {!desktop ? <DownloadCard onNavigate={onNavigate} /> : null}
      <a
        href={siteConfig.github}
        target="_blank"
        rel="noreferrer"
        className="mx-2 mb-2 flex h-8 items-center gap-2.5 rounded-[var(--ev-r-ctl)] px-2.5 font-round text-[13px] font-semibold text-ev-ink-2 transition hover:bg-[var(--ev-hover)] hover:text-ev-ink"
      >
        <GithubMark className="h-3.5 w-3.5" />
        Open source on GitHub
      </a>
      <AccountFooter onNavigate={onNavigate} />
    </aside>
  );
}

function PrimaryNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Workspace" className="mt-3 space-y-0.5 px-2">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = item.href === '/app'
          ? pathname === '/app' || pathname === '/app/'
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-9 items-center gap-2.5 rounded-[var(--ev-r-ctl)] px-2.5 font-round text-[14px] font-semibold transition',
              active
                ? 'bg-ev-coat-soft text-ev-coat'
                : 'text-ev-ink-2 hover:bg-[var(--ev-hover)] hover:text-ev-ink',
            )}
          >
            <Icon className="h-4 w-4" strokeWidth={1.75} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function RecentRow({ item, onNavigate }: { item: LibItem; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = pathname === item.href;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      title={item.title}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex h-8 items-center gap-2.5 rounded-[var(--ev-r-ctl)] px-2.5 text-[13px] transition',
        active
          ? 'bg-ev-raised text-ev-ink shadow-[var(--ev-e-2)]'
          : 'text-ev-ink-2 hover:bg-[var(--ev-hover)] hover:text-ev-ink',
      )}
    >
      <KindIcon item={item} size={14} className="shrink-0 text-ev-ink-3 group-hover:text-ev-coat" />
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      {item.kind === 'meeting' && item.status && item.status !== 'complete' ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ev-coat" title="Writing it down…" />
      ) : null}
    </Link>
  );
}

function DownloadCard({ onNavigate }: { onNavigate?: () => void }) {
  const { data: me } = useMe();
  if (!me || me.hasMac) return null;
  return (
    <Link
      href="/download/mac"
      onClick={onNavigate}
      className="mx-2 mb-1 flex h-8 items-center gap-2.5 rounded-[var(--ev-r-ctl)] px-2.5 font-round text-[13px] font-semibold text-ev-ink-2 transition hover:bg-[var(--ev-hover)] hover:text-ev-ink"
    >
      <Apple className="h-3.5 w-3.5" />
      Get the Mac app
    </Link>
  );
}

function TopSearch() {
  const router = useRouter();
  const { items } = useLibraryItems();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return items.filter((item) => item.title.toLowerCase().includes(normalized)).slice(0, 8);
  }, [query, items]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  function go(href: string) {
    setNavigationError(null);
    setOpen(false);
    void router.push(href)
      .then(() => setQuery(''))
      .catch((error: unknown) => {
        console.error('Navigation failed', error);
        setNavigationError('Could not open that result. Please try again.');
        setOpen(true);
      });
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!results.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(results[active].href);
    }
  }

  const listId = 'workspace-search-results';
  return (
    <div className="min-w-0 flex-1">
      <div ref={ref} className="relative w-full max-w-xl">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ev-ink-3" strokeWidth={1.75} />
        <input
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setNavigationError(null);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search"
          aria-label="Search your library"
          aria-expanded={open && Boolean(query.trim())}
          aria-controls={listId}
          aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
          className="h-9 w-full rounded-[var(--ev-r-ctl)] bg-ev-well pl-9 pr-3 font-round text-[13.5px] text-ev-ink outline-none transition placeholder:text-ev-ink-3 focus:bg-ev-raised focus:shadow-[var(--ev-focus)]"
        />

        {open && query.trim() ? (
          <div
            id={listId}
            role="listbox"
            className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-[var(--ev-r-pop)] bg-ev-raised p-1 shadow-[0_0_0_0.5px_var(--ev-line-strong),var(--ev-e-2)]"
          >
            {navigationError ? (
              <p role="alert" className="border-b border-ev-line px-3 py-2 text-xs text-ev-warn-ink">
                {navigationError}
              </p>
            ) : null}
            {results.length === 0 ? (
              <p className="px-3 py-3 text-sm text-ev-ink-2">No title matches yet.</p>
            ) : (
              results.map((item, index) => (
                <button
                  id={`${listId}-${index}`}
                  key={`${item.kind}-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => go(item.href)}
                  className={cn(
                    'flex h-9 w-full items-center gap-2.5 rounded-[var(--ev-r-ctl)] px-2.5 text-left text-sm',
                    index === active ? 'bg-ev-coat-soft text-ev-coat' : 'hover:bg-[var(--ev-hover)]',
                  )}
                >
                  <KindIcon item={item} size={14} className="shrink-0 text-ev-ink-2" />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <span className="shrink-0 text-xs text-ev-ink-2">
                    {new Date(item.createdAt).toLocaleDateString()}
                  </span>
                </button>
              ))
            )}
            <Link
              href={`/app/search?q=${encodeURIComponent(query.trim())}`}
              onClick={() => setOpen(false)}
              className="mt-1 flex h-9 items-center gap-2 rounded-[var(--ev-r-ctl)] border-t border-ev-line px-2.5 font-round text-xs font-semibold text-ev-ink-2 hover:bg-[var(--ev-hover)] hover:text-ev-ink"
            >
              <Search className="h-3.5 w-3.5" />
              Search inside transcripts for “{query.trim()}”
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AccountFooter({ onNavigate }: { onNavigate?: () => void }) {
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name = me?.displayName || me?.email?.split('@')[0] || 'Account';
  const initials = (me?.displayName || me?.email || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  return (
    <div ref={ref} className="relative border-t border-ev-line p-3">
      {open ? (
        <div className="absolute bottom-[calc(100%-0.25rem)] left-3 right-3 z-50 overflow-hidden rounded-[var(--ev-r-pop)] bg-ev-raised p-1 shadow-[0_0_0_0.5px_var(--ev-line-strong),var(--ev-e-2)]">
          <Link
            href="/app/settings"
            onClick={() => {
              setOpen(false);
              onNavigate?.();
            }}
            className="flex h-9 items-center gap-2.5 rounded-[var(--ev-r-ctl)] px-2.5 font-round text-[13.5px] font-semibold hover:bg-[var(--ev-hover)]"
          >
            <Settings className="h-4 w-4 text-ev-ink-2" strokeWidth={1.75} />
            Account settings
          </Link>
          <SignOut />
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-11 w-full items-center gap-2.5 rounded-[var(--ev-r-pop)] px-1.5 text-left transition hover:bg-[var(--ev-hover)]"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ev-manila-soft font-round text-xs font-extrabold text-ev-manila-ink">
          {initials || '?'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-round text-sm font-bold text-ev-ink">{name}</span>
          <span className="block truncate text-xs text-ev-ink-2">{me?.email ?? 'Signed in'}</span>
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-ev-ink-3" strokeWidth={1.75} />
      </button>
    </div>
  );
}

function SignOut() {
  const signOut = useSignOut();
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        setSigningOut(true);
        setFailed(false);
        void signOut({ redirectUrl: '/' }).catch((error: unknown) => {
          console.error('Sign out failed', error);
          setFailed(true);
          setSigningOut(false);
        });
      }}
      disabled={signingOut}
      className="flex h-9 w-full items-center gap-2.5 rounded-[var(--ev-r-ctl)] px-2.5 text-left font-round text-[13.5px] font-semibold text-ev-warn-ink hover:bg-ev-warn-soft disabled:cursor-wait disabled:opacity-60"
    >
      <LogOut className="h-4 w-4" />
      {failed ? 'Sign out failed · Try again' : signingOut ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
