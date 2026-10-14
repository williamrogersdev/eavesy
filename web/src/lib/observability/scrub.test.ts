import { describe, expect, test } from 'bun:test';
import type { ErrorEvent } from '@sentry/cloudflare';
import { scrubBreadcrumb, scrubEvent, scrubText, scrubUrl } from './scrub';

const TRANSCRIPT = 'Dana: we should cut the Q3 marketing budget by forty percent before the board sees it';
const ANTHROPIC_KEY = 'sk-ant-api03-Zx9yQ8wV7uT6sR5qP4oN3mL2kJ1iH0gF-abcdEFGH_ijkl';
const BEARER = 'Bearer eavesy_device_kq2N0dS8mX4bV7cZ1aP9wE3rT6yU5iO0lK8jH2gF4dS';
const CLERK_JWT =
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzJhYmMiLCJleHAiOjE3MDAwMDAwMDB9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU';
const EMAIL = 'dana.whitfield@example.com';

function realisticEvent(): ErrorEvent {
  return {
    type: undefined,
    message: `summary failed for ${EMAIL}: anthropic said 401 with key ${ANTHROPIC_KEY}`,
    transaction: 'POST /api/meetings/$id/summary',
    server_name: 'worker',
    exception: {
      values: [
        {
          type: 'Error',
          value: `upstream rejected ${BEARER} while summarising meeting 01JA2B3C4D5E6F7G8H9J0K1M2N`,
          stacktrace: {
            frames: [{ filename: 'worker.js', function: 'handleSummarize', vars: { transcript: TRANSCRIPT } }],
          },
        },
      ],
    },
    request: {
      url: 'https://eavesy.com/api/meetings/01JA2B3C4D5E6F7G8H9J0K1M2N/summary?token=nt_0123456789abcdef0123&email=x',
      method: 'POST',
      headers: { authorization: BEARER, cookie: '__session=abc' },
      cookies: { __session: CLERK_JWT },
      data: { transcript: TRANSCRIPT, notes: 'private notes' },
      query_string: 'token=nt_0123456789abcdef0123',
    },
    user: { id: 'user_2abc', email: EMAIL, ip_address: '203.0.113.9', username: 'dana' },
    breadcrumbs: [
      { category: 'fetch', data: { url: 'https://api.anthropic.com/v1/messages?beta=true', method: 'POST', status_code: 401, request_body: TRANSCRIPT } },
      { category: 'console', level: 'log', message: TRANSCRIPT },
      { category: 'console', level: 'error', message: `retrying with ${CLERK_JWT}` },
    ],
    contexts: {
      runtime: { name: 'cloudflare', version: '2026-07-16' },
      details: { job: { kind: 'summarize', meetingId: '01JA2B3C4D5E6F7G8H9J0K1M2N' }, transcript: TRANSCRIPT, userId: 'user_2abc' },
    },
    extra: { summary: 'Decided to cut budget', attempts: 3 },
    tags: { service: 'processing', failure: `key ${ANTHROPIC_KEY}` },
  };
}

describe('scrubEvent', () => {
  const event = scrubEvent(realisticEvent());
  const serialized = JSON.stringify(event);

  test('removes transcript text, notes, summaries and request bodies', () => {
    expect(serialized).not.toContain('marketing budget');
    expect(serialized).not.toContain('private notes');
    expect(serialized).not.toContain('Decided to cut budget');
    expect(event.request).toEqual({
      url: 'https://eavesy.com/api/meetings/01JA2B3C4D5E6F7G8H9J0K1M2N/summary',
      method: 'POST',
    });
  });

  test('removes API keys, bearer tokens, JWTs, cookies, emails and IPs', () => {
    for (const secret of [ANTHROPIC_KEY, BEARER, 'eavesy_device_', CLERK_JWT, EMAIL, '203.0.113.9', '__session', 'nt_0123']) {
      expect(serialized).not.toContain(secret);
    }
  });

  test('keeps the message, exception value, route, method and opaque user id', () => {
    expect(event.message).toBe('summary failed for [email]: anthropic said 401 with key [api-key]');
    expect(event.exception?.values?.[0]?.value).toBe(
      'upstream rejected Bearer [token] while summarising meeting 01JA2B3C4D5E6F7G8H9J0K1M2N',
    );
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.function).toBe('handleSummarize');
    expect(event.transaction).toBe('POST /api/meetings/$id/summary');
    expect(event.user).toEqual({ id: 'user_2abc' });
    expect(event.server_name).toBeUndefined();
  });

  test('keeps useful breadcrumbs and job context, drops console noise', () => {
    expect(event.breadcrumbs).toEqual([
      { category: 'fetch', data: { url: 'https://api.anthropic.com/v1/messages', method: 'POST', status_code: 401 } },
      { category: 'console', level: 'error', message: 'retrying with [jwt]' },
    ]);
    expect(event.contexts?.runtime).toEqual({ name: 'cloudflare', version: '2026-07-16' });
    expect(event.contexts?.details).toEqual({
      job: { kind: 'summarize', meetingId: '01JA2B3C4D5E6F7G8H9J0K1M2N' },
      transcript: '[filtered]',
      userId: 'user_2abc',
    });
    expect(event.extra).toEqual({ summary: '[filtered]', attempts: 3 });
    expect(event.tags).toEqual({ service: 'processing', failure: 'key [api-key]' });
  });

  test('redactPath hides MCP token paths', () => {
    const mcp = scrubEvent(
      { request: { url: 'https://mcp.eavesy.com/sometoken123/rpc', method: 'POST' }, transaction: 'POST /sometoken123' },
      { redactPath: true },
    );
    expect(mcp.request).toEqual({ url: 'https://mcp.eavesy.com/[redacted]', method: 'POST' });
    expect(mcp.transaction).toBe('POST /[redacted]');
  });
});

describe('scrub helpers', () => {
  test('scrubText strips query strings from embedded URLs', () => {
    expect(scrubText('GET https://eavesy.com/api/search?q=layoffs failed')).toBe(
      'GET https://eavesy.com/api/search failed',
    );
  });

  test('scrubUrl keeps relative paths', () => {
    expect(scrubUrl('/app/meetings/01JA2B?tab=notes#x')).toBe('/app/meetings/01JA2B');
  });

  test('scrubBreadcrumb drops input breadcrumbs', () => {
    expect(scrubBreadcrumb({ category: 'ui.input', message: 'textarea' })).toBeNull();
  });

  test('does not mangle ordinary ids or versions', () => {
    expect(scrubText('meeting 01JA2B3C4D5E6F7G8H9J0K1M2N at v0.1.9')).toBe('meeting 01JA2B3C4D5E6F7G8H9J0K1M2N at v0.1.9');
  });
});
