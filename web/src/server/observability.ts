import * as Sentry from '@sentry/cloudflare';
import type { CloudflareOptions } from '@sentry/cloudflare';

export const withSentry = Sentry.withSentry;
export const captureMessage = Sentry.captureMessage;

export function sentryOptions(
  env: { SENTRY_DSN?: string; SENTRY_ENVIRONMENT?: string },
  opts: { service: string; redactPath?: boolean },
): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.SENTRY_ENVIRONMENT ?? 'production',
    initialScope: { tags: { service: opts.service } },
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeBreadcrumb() { return null; },
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.extra;
      delete event.breadcrumbs;
      delete event.contexts;
      if (event.message) event.message = `${opts.service} Worker operation failed`;
      for (const exception of event.exception?.values ?? []) {
        exception.value = `${opts.service} Worker operation failed`;
      }
      return event;
    },
  };
}

export function reportError(message: string, error: unknown, context: Record<string, unknown> = {}) {
  console.error(
    JSON.stringify({
      message,
      ...context,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  Sentry.withScope((scope) => {
    scope.setContext('details', context);
    scope.setTag('failure', message);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  });
}
