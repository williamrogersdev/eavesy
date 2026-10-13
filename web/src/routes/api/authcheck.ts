import { createFileRoute } from '@tanstack/react-router';
import { auth } from '@clerk/tanstack-react-start/server';

function pkInstanceDomain(pk?: string): string | null {
  if (!pk) return null;
  try {
    const b64 = pk.replace(/^pk_(live|test)_/, '');
    const decoded = atob(b64);
    return decoded.replace(/\$$/, '');
  } catch {
    return null;
  }
}

export const Route = createFileRoute('/api/authcheck')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cookieHeader = request.headers.get('cookie') ?? '';
        const cookieNames = cookieHeader
          .split(';')
          .map((c) => c.trim().split('=')[0])
          .filter(Boolean);

        let userId: string | null = null;
        let sessionId: string | null = null;
        let authError: string | null = null;
        try {
          const a = await auth();
          userId = a.userId ?? null;
          sessionId = a.sessionId ?? null;
        } catch (err) {
          authError = err instanceof Error ? err.message : String(err);
        }

        const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
          .process?.env ?? {};
        const pk =
          env.CLERK_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? undefined;

        return Response.json({
          serverSeesSession: Boolean(userId),
          userId,
          sessionId,
          authError,
          authReason: request.headers.get('x-clerk-auth-reason'),
          authStatus: request.headers.get('x-clerk-auth-status'),
          clerkCookiesPresent: {
            __session: cookieNames.includes('__session'),
            __client_uat: cookieNames.includes('__client_uat'),
          },
          cookieNames,
          hasSecretKey: Boolean(env.CLERK_SECRET_KEY),
          hasPublishableKey_CLERK_PUBLISHABLE_KEY: Boolean(env.CLERK_PUBLISHABLE_KEY),
          hasPublishableKey_NEXT_PUBLIC: Boolean(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY),
          publishableInstanceDomain: pkInstanceDomain(pk),
          host: new URL(request.url).host,
        });
      },
    },
  },
});
