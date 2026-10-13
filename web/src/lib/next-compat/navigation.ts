import {
  useNavigate,
  useParams as useTSParams,
  useRouterState,
  redirect as tsRedirect,
  notFound as tsNotFound,
} from '@tanstack/react-router';

export function usePathname(): string {
  return useRouterState({ select: (s) => s.location.pathname });
}

export function useSearchParams(): URLSearchParams {
  const search = useRouterState({ select: (s) => s.location.searchStr });
  return new URLSearchParams(search ?? '');
}

export function useRouter() {
  const navigate = useNavigate();
  return {
    push: (href: string) => navigate({ href }),
    replace: (href: string) => navigate({ href, replace: true }),
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh: () =>
      navigate({ to: window.location.pathname as never, replace: true }),
    prefetch: () => {},
  };
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return useTSParams({ strict: false } as never) as T;
}

export function redirect(href: string): never {
  throw tsRedirect({ href });
}

export function notFound(): never {
  throw tsNotFound();
}
