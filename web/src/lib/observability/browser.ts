// Browser analytics and error tracking (PostHog). Off unless VITE_POSTHOG_KEY
// is set at build time; the SDK is loaded lazily so builds without a key
// never download it, and it never fetches remote scripts.
import { scrubAnalyticsEvent } from './scrub';

type PostHog = (typeof import('posthog-js/dist/module.no-external'))['default'];

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || 'https://us.i.posthog.com';

let loading: Promise<PostHog | null> | null = null;

function load(): Promise<PostHog | null> {
  if (!KEY || typeof window === 'undefined') return Promise.resolve(null);
  loading ??= Promise.all([
    import('posthog-js/dist/module.no-external'),
    import('posthog-js/dist/exception-autocapture'),
  ])
    .then(([{ default: posthog }]) => {
      posthog.init(KEY, {
        api_host: HOST,
        defaults: '2026-01-30',
        capture_pageview: 'history_change',
        capture_pageleave: true,
        // Clicks and inputs carry on-page text (meeting and note titles).
        autocapture: false,
        rageclick: false,
        capture_dead_clicks: false,
        capture_heatmaps: false,
        disable_session_recording: true,
        disable_surveys: true,
        disable_web_experiments: true,
        disable_external_dependency_loading: true,
        person_profiles: 'identified_only',
        capture_exceptions: { capture_console_errors: false },
        before_send: (event) => (event ? scrubAnalyticsEvent(event) : null),
        loaded: (client) => client.register({ service: 'browser', release: import.meta.env.VITE_RELEASE as string | undefined }),
      });
      return posthog;
    })
    .catch(() => null);
  return loading;
}

export function initBrowserAnalytics(): void {
  void load();
}

/** Errors caught by a React/router boundary never reach window.onerror. */
export function reportClientError(error: unknown): void {
  void load().then((posthog) => posthog?.captureException(error));
}
