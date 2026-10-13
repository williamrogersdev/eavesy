const WEB_ORIGIN = 'https://eavesy.com';

interface TauriGlobal {
  core?: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
}

function tauri(): TauriGlobal | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

function openExternal(href: string): void {
  const url = href.startsWith('http')
    ? href
    : `${WEB_ORIGIN}${href.startsWith('/') ? '' : '/'}${href}`;

  const t = tauri();
  if (t?.core?.invoke) {
    t.core.invoke('plugin:shell|open', { path: url }).catch(() => {
      window.open(url, '_blank');
    });
    t.core.invoke('hide_panel').catch(() => {});
    return;
  }
  window.open(url, '_blank');
}

export function useRouter() {
  return {
    push: (href: string) => openExternal(href),
    replace: (href: string) => openExternal(href),
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  };
}

export function usePathname(): string {
  return '/launcher';
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}
