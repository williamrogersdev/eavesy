import { reportError, withErrorReporting, type ObservabilityEnv } from '@/server/observability';
import { withRequestTiming } from '@/server/perf';
import { hubNamespace } from '@/server/drops-hub';
import handler from '@tanstack/react-start/server-entry';
import { getDb } from '@/db/client';
import { purgeExpiredInvites } from '@/db/repo/teams';
import { BACKGROUND_SYNC_CRON, syncAllDue } from '@/server/calendar-sync';

export { DropsHub } from '@/server/drops-hub';

type Env = ObservabilityEnv;

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

  /** Every five minutes: refresh connected calendars, so upcoming meetings are known without the app open; also drop lapsed team invitations. */
  async scheduled(controller: ScheduledController): Promise<void> {
    if (controller.cron !== BACKGROUND_SYNC_CRON) return;
    const db = getDb();
    await purgeExpiredInvites(db).catch((error: unknown) => reportError('expired team invite sweep failed', error));
    await syncAllDue(db);
  },
};

export default withErrorReporting<Env>({ service: 'web' }, worker);
