// Shared Sentry scrubbing for the Workers and the browser client.
//
// Goal: an event still says what failed and where (message, exception value,
// route, method, release, breadcrumbs) but never carries user content
// (transcripts, notes, summaries, request bodies), credentials, cookies,
// emails, or IPs. Free text is scrubbed with patterns; structured data is
// filtered by key name, because transcript text has no recognisable shape.

/** Sentry `dataCollection`: collect nothing that can carry user content. */
export const PRIVATE_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [] as [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};

const MAX_TEXT = 1_000;
const MAX_BREADCRUMB_TEXT = 300;
const MAX_DEPTH = 4;

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]'],
  [/\b(?:Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '[credential]'],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[api-key]'],
  [/\bsk-or-[A-Za-z0-9_-]{8,}/g, '[api-key]'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, '[api-key]'],
  [/\bwhsec_[A-Za-z0-9]{8,}/g, '[api-key]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[api-key]'],
  [/\beavesy_device_[A-Za-z0-9_-]{8,}/g, '[token]'],
  [/\bnt_[0-9a-f]{16,}/g, '[token]'],
  [/\banon_[0-9a-f-]{16,}/gi, '[token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]'],
  // Long hex or base64url runs are hashes, signatures, or opaque secrets.
  [/\b[0-9a-f]{32,}\b/gi, '[token]'],
  [/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g, '[token]'],
];

// Keys whose values are user content or credentials, whatever their shape.
const SENSITIVE_KEY =
  /text|transcript|summary|summaries|note|body|content|prompt|title|description|blurb|token|secret|password|passwd|api[-_]?key|authorization|cookie|session|email|ip_address|^ip$|phone|name$/i;

const SDK_CONTEXTS = new Set([
  'app',
  'browser',
  'cloud_resource',
  'culture',
  'device',
  'os',
  'runtime',
  'trace',
]);

// Breadcrumb data keys that describe a request or navigation, not content.
const BREADCRUMB_DATA_KEYS = new Set([
  'url',
  'method',
  'status_code',
  'from',
  'to',
  'reason',
  'http.method',
  'http.response.status_code',
]);

export function scrubText(value: string, max = MAX_TEXT): string {
  let text = value.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, '$1');
  for (const [pattern, replacement] of TEXT_PATTERNS) text = text.replace(pattern, replacement);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Drop query string and fragment; optionally hide the whole path. */
export function scrubUrl(value: string, opts: { redactPath?: boolean } = {}): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)/i.exec(value);
  const origin = match?.[1] ?? '';
  const path = match?.[2] ?? '';
  if (opts.redactPath) return `${origin}/[redacted]`;
  return scrubText(`${origin}${path}`);
}

export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[filtered]' : scrubValue(item, depth + 1);
  }
  return out;
}

export interface ScrubOptions {
  /** Hide URL paths entirely (the MCP Worker accepts tokens as the path). */
  redactPath?: boolean;
}

interface ScrubbableBreadcrumb {
  category?: string;
  message?: string;
  data?: { [key: string]: unknown };
  level?: string;
}

/** Returns null to drop the breadcrumb. */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(
  breadcrumb: T,
  opts: ScrubOptions = {},
): T | null {
  // Console output and DOM input can echo anything on the page.
  if (breadcrumb.category === 'console' && breadcrumb.level !== 'error' && breadcrumb.level !== 'warning') {
    return null;
  }
  if (breadcrumb.category === 'ui.input') return null;
  if (breadcrumb.message) breadcrumb.message = scrubText(breadcrumb.message, MAX_BREADCRUMB_TEXT);
  if (breadcrumb.data) {
    const data: { [key: string]: unknown } = {};
    for (const [key, value] of Object.entries(breadcrumb.data)) {
      if (!BREADCRUMB_DATA_KEYS.has(key)) continue;
      data[key] =
        typeof value === 'string'
          ? key === 'url' || key === 'from' || key === 'to'
            ? scrubUrl(value, opts)
            : scrubText(value, MAX_BREADCRUMB_TEXT)
          : value;
    }
    breadcrumb.data = data;
  }
  return breadcrumb;
}

interface ScrubbableEvent {
  message?: string;
  transaction?: string;
  server_name?: string;
  exception?: {
    values?: Array<{
      value?: string;
      stacktrace?: { frames?: Array<{ vars?: { [key: string]: unknown } }> };
    }>;
  };
  request?: { url?: string; method?: string };
  user?: { id?: string | number; [key: string]: unknown };
  breadcrumbs?: ScrubbableBreadcrumb[];
  contexts?: { [key: string]: unknown };
  extra?: { [key: string]: unknown };
  tags?: { [key: string]: unknown };
  spans?: Array<{ description?: string; data?: { [key: string]: unknown } }>;
}

export function scrubEvent<T extends ScrubbableEvent>(event: T, opts: ScrubOptions = {}): T {
  if (event.message) event.message = scrubText(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }

  if (event.request) {
    const { url, method } = event.request;
    event.request = {
      ...(url ? { url: scrubUrl(url, opts) } : {}),
      ...(method ? { method } : {}),
    };
  }
  if (event.transaction) {
    event.transaction = opts.redactPath
      ? event.transaction.replace(/\/\S*/, '/[redacted]')
      : scrubText(event.transaction);
  }

  // Keep only an opaque id so issues can be counted per user.
  if (event.user) {
    const id = event.user.id;
    event.user = id === undefined ? undefined : { id };
    if (!event.user) delete event.user;
  }
  delete event.server_name;

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map((breadcrumb) => scrubBreadcrumb(breadcrumb, opts))
      .filter((breadcrumb): breadcrumb is ScrubbableBreadcrumb => breadcrumb !== null);
  }
  if (event.contexts) {
    // SDK contexts (runtime, os, browser, trace…) describe the environment;
    // anything our code attached is filtered by key.
    for (const [key, value] of Object.entries(event.contexts)) {
      if (!SDK_CONTEXTS.has(key)) event.contexts[key] = scrubValue(value);
    }
  }
  if (event.extra) event.extra = scrubValue(event.extra) as T['extra'];
  if (event.tags) {
    for (const [key, value] of Object.entries(event.tags)) {
      if (typeof value === 'string') event.tags[key] = scrubText(value, MAX_BREADCRUMB_TEXT);
    }
  }
  for (const span of event.spans ?? []) {
    if (span.description) {
      span.description = opts.redactPath
        ? span.description.replace(/\/\S*/, '/[redacted]')
        : scrubText(span.description);
    }
    if (span.data) span.data = scrubSpanData(span.data, opts);
  }
  return event;
}

function scrubSpanData(data: { [key: string]: unknown }, opts: ScrubOptions) {
  const out: { [key: string]: unknown } = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEY.test(key) || /query|statement|args|input|output|message/i.test(key)) continue;
    out[key] =
      typeof value === 'string'
        ? /url|target|route/i.test(key)
          ? scrubUrl(value, opts)
          : scrubText(value, MAX_BREADCRUMB_TEXT)
        : value;
  }
  return out;
}
