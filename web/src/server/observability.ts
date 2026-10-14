import * as Sentry from '@sentry/cloudflare';
import type { CloudflareOptions } from '@sentry/cloudflare';
import { PRIVATE_DATA_COLLECTION, scrubBreadcrumb, scrubEvent, scrubStreamedSpan } from '../lib/observability/scrub';

export const withSentry = Sentry.withSentry;
export const captureMessage = Sentry.captureMessage;

export const TRACES_SAMPLE_RATE = 0.05;

export function sentryOptions(
  env: { SENTRY_DSN?: string; SENTRY_ENVIRONMENT?: string; SENTRY_RELEASE?: string },
  opts: { service: string; redactPath?: boolean },
): CloudflareOptions {
  const scrub = { redactPath: opts.redactPath };
  return {
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.SENTRY_ENVIRONMENT ?? 'production',
    release: env.SENTRY_RELEASE,
    initialScope: { tags: { service: opts.service } },
    tracesSampleRate: TRACES_SAMPLE_RATE,
    dataCollection: PRIVATE_DATA_COLLECTION,
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb, scrub),
    beforeSend: (event) => scrubEvent(event, scrub),
    beforeSendTransaction: (event) => scrubEvent(event, scrub),
    beforeSendSpan: (span) => scrubStreamedSpan(span, scrub),
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
    if (typeof context.userId === 'string') scope.setUser({ id: context.userId });
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  });
}
