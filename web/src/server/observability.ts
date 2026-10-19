import { env as workerEnv, waitUntil } from 'cloudflare:workers';
import { exceptionList, scrubText, scrubUrl, scrubValue } from '../lib/observability/scrub';

export interface ObservabilityEnv {
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
  RELEASE?: string;
  ENVIRONMENT?: string;
}

export interface ReportingOptions {
  service: string;
  /** Hide URL paths entirely (the MCP Worker accepts tokens as the path). */
  redactPath?: boolean;
}

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

let reporting: ReportingOptions = { service: 'web' };

type Properties = Record<string, unknown>;

function send(
  env: ObservabilityEnv | undefined,
  event: string,
  distinctId: string | undefined,
  properties: Properties,
): Promise<void> | undefined {
  const key = env?.POSTHOG_KEY;
  if (!key) return undefined;
  const host = (env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST).replace(/\/+$/, '');
  const body = {
    api_key: key,
    event,
    distinct_id: distinctId ?? `eavesy-${reporting.service}`,
    timestamp: new Date().toISOString(),
    properties: {
      ...properties,
      service: reporting.service,
      environment: env.ENVIRONMENT ?? 'production',
      ...(env.RELEASE ? { release: env.RELEASE } : {}),
      $lib: 'eavesy-worker',
      ...(distinctId ? {} : { $process_person_profile: false }),
    },
  };
  return fetch(`${host}/i/v0/e/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(
    () => undefined,
    () => undefined,
  );
}

function defer(pending: Promise<void> | undefined) {
  if (!pending) return;
  try {
    waitUntil(pending);
  } catch {
    void pending;
  }
}

function runtimeEnv(): ObservabilityEnv {
  return workerEnv;
}

function exceptionEvent(
  error: unknown,
  handled: boolean,
  properties: Properties,
): Properties {
  return { $exception_list: exceptionList(error, { handled }), ...properties };
}

/** Log a failure and send it to PostHog error tracking, scrubbed. */
export function reportError(message: string, error: unknown, context: Record<string, unknown> = {}) {
  console.error(
    JSON.stringify({
      message,
      ...context,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  const userId = typeof context.userId === 'string' ? context.userId : undefined;
  defer(
    send(
      runtimeEnv(),
      '$exception',
      userId,
      exceptionEvent(error, true, { failure: scrubText(message), details: scrubValue(context) }),
    ),
  );
}

/** A failure without an Error object, grouped by its message. */
export function captureMessage(message: string, opts: { tags?: Record<string, string> } = {}) {
  console.error(JSON.stringify({ message, ...opts.tags }));
  defer(
    send(runtimeEnv(), '$exception', undefined, {
      $exception_list: [{ type: message, value: message, mechanism: { handled: true, synthetic: true } }],
      $exception_fingerprint: message,
      ...(opts.tags ? { details: scrubValue(opts.tags) } : {}),
    }),
  );
}

/** A product event for a known user. Never pass content: ids, kinds and counts only. */
export function trackEvent(userId: string, event: string, properties: Properties = {}) {
  defer(send(runtimeEnv(), event, userId, properties));
}

type Handler<E, Q> = ExportedHandler<E, Q>;

/**
 * Report errors that escape a Worker's fetch, queue or scheduled handler,
 * then rethrow so the runtime still sees the failure.
 */
export function withErrorReporting<E extends ObservabilityEnv, Q = unknown>(
  options: ReportingOptions,
  handler: Handler<E, Q>,
): Handler<E, Q> {
  reporting = options;
  const wrapped: Handler<E, Q> = { ...handler };
  const report = (env: E, ctx: ExecutionContext, error: unknown, properties: Properties) =>
    ctx.waitUntil(send(env, '$exception', undefined, exceptionEvent(error, false, properties)) ?? Promise.resolve());

  if (handler.fetch) {
    const fetchHandler = handler.fetch;
    wrapped.fetch = async (request, env, ctx) => {
      try {
        return await fetchHandler.call(handler, request, env, ctx);
      } catch (error) {
        report(env, ctx, error, {
          $current_url: scrubUrl(request.url, options),
          method: request.method,
        });
        throw error;
      }
    };
  }
  if (handler.queue) {
    const queueHandler = handler.queue;
    wrapped.queue = async (batch, env, ctx) => {
      try {
        await queueHandler.call(handler, batch, env, ctx);
      } catch (error) {
        report(env, ctx, error, { queue: batch.queue });
        throw error;
      }
    };
  }
  if (handler.scheduled) {
    const scheduledHandler = handler.scheduled;
    wrapped.scheduled = async (controller, env, ctx) => {
      try {
        await scheduledHandler.call(handler, controller, env, ctx);
      } catch (error) {
        report(env, ctx, error, { cron: controller.cron });
        throw error;
      }
    };
  }
  return wrapped;
}
