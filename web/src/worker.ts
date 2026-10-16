import { sentryOptions, withSentry } from '@/server/observability';
import { withRequestTiming } from '@/server/perf';
import { hubNamespace } from '@/server/drops-hub';
import handler from '@tanstack/react-start/server-entry';

export { DropsHub } from '@/server/drops-hub';

interface Env {
  SENTRY_DSN?: string;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Live drop sync sockets skip the app handler: the per-user DropsHub
    // authenticates them with the one-time ticket from /api/drops/ticket.
    if (url.pathname === '/api/drops/live') {
      const userId = url.searchParams.get('u');
      if (!userId) return new Response('missing user', { status: 400 });
      const ns = hubNamespace(env);
      return ns.get(ns.idFromName(userId)).fetch(request);
    }

    const handle = async () =>
      (
        handler.fetch as (
          req: Request,
          runtimeEnv: unknown,
          executionContext: ExecutionContext,
        ) => Response | Promise<Response>
      )(request, env, ctx);
    if (url.pathname.startsWith('/api/')) return withRequestTiming(request, handle);
    const response = await handle();
    if (url.pathname.startsWith('/connect/')) {
      // Consent pages grant access with one click: never inside someone else's frame.
      const framed = new Response(response.body, response);
      framed.headers.set('x-frame-options', 'DENY');
      framed.headers.set('content-security-policy', "frame-ancestors 'none'");
      return framed;
    }
    return response;
  },
};

export default withSentry<Env>(
  (env: Env) => sentryOptions(env, { service: 'web' }),
  worker,
);
