import { sentryOptions, withSentry } from '@/server/observability';
import { withRequestTiming } from '@/server/perf';
import handler from '@tanstack/react-start/server-entry';

interface Env {
  SENTRY_DSN?: string;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const handle = async () =>
      (
        handler.fetch as (
          req: Request,
          runtimeEnv: unknown,
          executionContext: ExecutionContext,
        ) => Response | Promise<Response>
      )(request, env, ctx);
    return new URL(request.url).pathname.startsWith('/api/')
      ? withRequestTiming(request, handle)
      : handle();
  },
};

export default withSentry<Env>(
  (env: Env) => sentryOptions(env, { service: 'web' }),
  worker,
);
