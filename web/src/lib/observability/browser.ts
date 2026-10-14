// Browser error reporting. Off unless VITE_SENTRY_DSN is set at build time;
// the SDK is loaded lazily so builds without a DSN never download it.
import { PRIVATE_DATA_COLLECTION, scrubBreadcrumb, scrubEvent } from './scrub';

type BrowserSentry = typeof import('@sentry/browser');

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const TRACES_SAMPLE_RATE = 0.05;

let loading: Promise<BrowserSentry | null> | null = null;

function load(): Promise<BrowserSentry | null> {
  if (!DSN || typeof window === 'undefined') return Promise.resolve(null);
  loading ??= import('@sentry/browser')
    .then((Sentry) => {
      Sentry.init({
        dsn: DSN,
        release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
        environment: import.meta.env.MODE,
        dataCollection: PRIVATE_DATA_COLLECTION,
        tracesSampleRate: TRACES_SAMPLE_RATE,
        // Same-origin API calls only; never send trace headers to third parties.
        tracePropagationTargets: [/^\/(?!\/)/],
        integrations: [Sentry.browserTracingIntegration()],
        initialScope: { tags: { service: 'browser' } },
        beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
        beforeSend: (event) => scrubEvent(event),
        beforeSendTransaction: (event) => scrubEvent(event),
      });
      return Sentry;
    })
    .catch(() => null);
  return loading;
}

export function initBrowserErrorReporting(): void {
  void load();
}

/** Errors caught by a React/router boundary never reach window.onerror. */
export function reportClientError(error: unknown): void {
  void load().then((Sentry) => Sentry?.captureException(error));
}
