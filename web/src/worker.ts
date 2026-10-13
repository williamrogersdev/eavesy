import { sentryOptions, withSentry } from '@/server/observability';
import handler from '@tanstack/react-start/server-entry';

interface Env {
  SENTRY_DSN?: string;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return (
      handler.fetch as (
        req: Request,
        runtimeEnv: unknown,
        executionContext: ExecutionContext,
      ) => Response | Promise<Response>
    )(request, env, ctx);
  },
};

export default withSentry<Env>(
  (env: Env) => sentryOptions(env, { service: 'web' }),
  worker,
);
