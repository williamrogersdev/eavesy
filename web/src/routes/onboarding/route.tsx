import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getDb } from '@/db/client';
import * as usersRepo from '@/db/repo/users';
import { appReturnPath } from '@/lib/auth-return';
import { resolveActor } from '@/server/auth';

const getOnboardingGate = createServerFn({ method: 'GET' }).handler(async () => {
  let actor: Awaited<ReturnType<typeof resolveActor>> | null = null;
  try {
    actor = await resolveActor();
  } catch {
    actor = null;
  }
  if (!actor) return { redirectTo: '/sign-in' as const };

  const user = await usersRepo.getById(getDb(), actor.userId);
  if (user?.onboardingCompletedAt) return { redirectTo: '/app' as const };

  return { redirectTo: null };
});

export const Route = createFileRoute('/onboarding')({
  validateSearch: (search: Record<string, unknown>) => ({ redirect_url: appReturnPath(search.redirect_url) }),
  beforeLoad: async ({ search, location }) => {
    const { redirectTo } = await getOnboardingGate();
    if (redirectTo === '/sign-in') throw redirect({ href: `/sign-in?redirect_url=${encodeURIComponent(location.href)}` });
    if (redirectTo === '/app') throw redirect({ href: search.redirect_url });
  },
  head: () => ({
    meta: [{ name: 'robots', content: 'noindex, nofollow' }],
  }),
  component: OnboardingLayout,
});

function OnboardingLayout() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-muted/35 px-4 py-8 sm:py-12">
      <Outlet />
    </main>
  );
}
