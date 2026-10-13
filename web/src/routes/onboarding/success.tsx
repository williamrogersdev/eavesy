import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getDb } from '@/db/client';
import { resolveActor } from '@/server/auth';
import { getStripe } from '@/lib/stripe';
import { finalizeSubscription } from '@/server/billing';

const finalizeOnboarding = createServerFn({ method: 'GET' })
  .validator((data: { sessionId?: string }) => data)
  .handler(async ({ data }) => {
    const sessionId = data.sessionId;

    let actor: Awaited<ReturnType<typeof resolveActor>> | null = null;
    try {
      actor = await resolveActor();
    } catch {
      actor = null;
    }
    if (!actor) return { redirectTo: '/sign-in' };
    if (!sessionId) return { redirectTo: '/onboarding?step=plan' };

    let ok = false;
    try {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const belongsToUser =
        session.client_reference_id === actor.userId || session.metadata?.userId === actor.userId;

      if (belongsToUser && session.subscription) {
        const subId =
          typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        const sub = await stripe.subscriptions.retrieve(subId);
        if (!sub.metadata?.userId) {
          sub.metadata = { ...sub.metadata, userId: actor.userId };
        }
        await finalizeSubscription(getDb(), sub);
        ok = true;
      }
    } catch (err) {
      console.error('onboarding success finalize failed', err);
    }

    return { redirectTo: ok ? '/app' : '/onboarding?step=plan' };
  });

export const Route = createFileRoute('/onboarding/success')({
  validateSearch: (search: Record<string, unknown>): { session_id?: string } => ({
    session_id: typeof search.session_id === 'string' ? search.session_id : undefined,
  }),
  beforeLoad: async ({ search }) => {
    const { redirectTo } = await finalizeOnboarding({ data: { sessionId: search.session_id } });
    throw redirect({ to: redirectTo as never });
  },
});
