// Shared PostHog scrubbing for the Workers and the browser client.
//
// Goal: an event still says what failed and where (exception value, stack,
// route, method, release) but never carries user content
// (transcripts, notes, summaries, request bodies), credentials, cookies,
// emails, or IPs. Free text is scrubbed with patterns; structured data is
// filtered by key name, because transcript text has no recognisable shape.

const MAX_TEXT = 1_000;
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

// Error messages that embed model output or response bodies by construction.
// Keep the description, drop whatever follows it.
const CONTENT_BEARING_MESSAGES = [/^(summary was not valid JSON):[\s\S]*$/];

export function scrubText(value: string, max = MAX_TEXT): string {
  let text = value;
  for (const pattern of CONTENT_BEARING_MESSAGES) text = text.replace(pattern, '$1 [content removed]');
  text = text.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, '$1');
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

interface StackFrame {
  platform: 'web:javascript' | 'node:javascript';
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/** V8 stack lines to PostHog raw frames, oldest call first. */
export function parseStack(stack: string | undefined, platform: StackFrame['platform'] = 'node:javascript'): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of (stack ?? '').split('\n')) {
    const match = V8_FRAME.exec(line);
    if (!match) continue;
    const filename = scrubUrl(match[2]);
    frames.push({
      platform,
      filename,
      ...(match[1] ? { function: match[1] } : {}),
      lineno: Number(match[3]),
      colno: Number(match[4]),
      in_app: !filename.includes('node_modules'),
    });
  }
  return frames.slice(0, 50).reverse();
}

/** PostHog `$exception_list` for an error, with the message scrubbed. */
export function exceptionList(error: unknown, opts: { handled: boolean }) {
  const err = error instanceof Error ? error : new Error(String(error));
  const frames = parseStack(err.stack);
  return [
    {
      type: err.name || 'Error',
      value: scrubText(err.message),
      mechanism: { handled: opts.handled, synthetic: false },
      ...(frames.length ? { stacktrace: { type: 'raw', frames } } : {}),
    },
  ];
}

// Page titles name meetings and notes; posthog-js sends document.title.
const DROPPED_PROPERTIES = new Set(['title', '$title', '$el_text', '$elements', '$elements_chain']);
const URL_PROPERTY = /url|referrer|href|pathname/i;

function scrubProperties(properties: { [key: string]: unknown }, opts: ScrubOptions) {
  for (const [key, value] of Object.entries(properties)) {
    if (DROPPED_PROPERTIES.has(key)) delete properties[key];
    else if (typeof value === 'string' && URL_PROPERTY.test(key)) properties[key] = scrubUrl(value, opts);
  }
}

interface ScrubbableException {
  value?: string;
  stacktrace?: { frames?: Array<{ filename?: string; vars?: unknown; pre_context?: unknown; post_context?: unknown; context_line?: unknown }> };
}

interface ScrubbableAnalyticsEvent {
  event: string;
  properties?: { [key: string]: unknown };
  $set?: { [key: string]: unknown };
  $set_once?: { [key: string]: unknown };
}

/**
 * posthog-js `before_send`: keep the event and route, drop query strings,
 * fragments and page titles, scrub exception text, and strip source context
 * from stack frames.
 */
export function scrubAnalyticsEvent<T extends ScrubbableAnalyticsEvent>(event: T, opts: ScrubOptions = {}): T {
  const bags = [event.properties, event.$set, event.$set_once, event.properties?.$set, event.properties?.$set_once];
  for (const bag of bags) {
    if (bag && typeof bag === 'object') scrubProperties(bag as { [key: string]: unknown }, opts);
  }

  const exceptions = event.properties?.$exception_list;
  if (Array.isArray(exceptions)) {
    for (const exception of exceptions as ScrubbableException[]) {
      if (exception.value) exception.value = scrubText(exception.value);
      for (const frame of exception.stacktrace?.frames ?? []) {
        if (frame.filename) frame.filename = scrubUrl(frame.filename);
        delete frame.vars;
        delete frame.pre_context;
        delete frame.post_context;
        delete frame.context_line;
      }
    }
  }
  for (const key of ['$exception_message', '$exception_values']) {
    const value: unknown = event.properties?.[key];
    if (typeof value === 'string') event.properties![key] = scrubText(value);
    else if (Array.isArray(value)) {
      event.properties![key] = (value as unknown[]).map((item) => (typeof item === 'string' ? scrubText(item) : item));
    }
  }
  return event;
}
