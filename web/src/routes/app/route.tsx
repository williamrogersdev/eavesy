import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { AppShell } from '@/components/shell/app-shell';
import { getDb } from '@/db/client';
import * as usersRepo from '@/db/repo/users';
import { resolveActor } from '@/server/auth';

const getAppGate = createServerFn({ method: 'GET' }).handler(async () => {
  let actor: Awaited<ReturnType<typeof resolveActor>> | null = null;
  try {
    actor = await resolveActor();
  } catch {
    actor = null;
  }
  if (!actor) return { redirectTo: '/sign-in' as const };

  const user = await usersRepo.getById(getDb(), actor.userId);
  if (!user?.onboardingCompletedAt) return { redirectTo: '/onboarding' as const };

  return { redirectTo: null };
});

export const Route = createFileRoute('/app')({
  beforeLoad: async ({ location }) => {
    const { redirectTo } = await getAppGate();
    if (!redirectTo) return;
    const href = `${redirectTo}?redirect_url=${encodeURIComponent(location.href)}`;
    throw redirect({ href });
  },
  head: () => ({
    meta: [{ name: 'robots', content: 'noindex, nofollow' }],
  }),
  component: AppLayout,
});

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
