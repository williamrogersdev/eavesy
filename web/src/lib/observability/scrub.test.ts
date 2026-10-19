import { describe, expect, test } from 'bun:test';
import { exceptionList, scrubAnalyticsEvent, scrubText, scrubUrl, scrubValue } from './scrub';

const TRANSCRIPT = 'Dana: we should cut the Q3 marketing budget by forty percent before the board sees it';
const ANTHROPIC_KEY = 'sk-ant-api03-Zx9yQ8wV7uT6sR5qP4oN3mL2kJ1iH0gF-abcdEFGH_ijkl';
const BEARER = 'Bearer eavesy_device_kq2N0dS8mX4bV7cZ1aP9wE3rT6yU5iO0lK8jH2gF4dS';
const CLERK_JWT =
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzJhYmMiLCJleHAiOjE3MDAwMDAwMDB9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU';
const EMAIL = 'dana.whitfield@example.com';

function pageview() {
  return {
    event: '$pageview',
    properties: {
      $current_url: 'https://eavesy.com/app/meetings/01JA2B3C4D5E6F7G8H9J0K1M2N?q=layoffs#notes',
      $pathname: '/app/meetings/01JA2B3C4D5E6F7G8H9J0K1M2N',
      $referrer: `https://mail.example.com/inbox?from=${EMAIL}`,
      title: 'Board layoffs with Dana — Eavesy',
      $browser: 'Chrome',
      $set_once: { $initial_current_url: 'https://eavesy.com/sign-up?__clerk_ticket=abc' },
    },
  };
}

function exceptionEvent() {
  return {
    event: '$exception',
    properties: {
      $current_url: 'https://eavesy.com/app?token=nt_0123456789abcdef0123',
      $exception_list: [
        {
          type: 'Error',
          value: `upstream rejected ${BEARER} for ${EMAIL} with ${ANTHROPIC_KEY}`,
          stacktrace: {
            type: 'raw',
            frames: [
              {
                filename: 'https://eavesy.com/assets/app.js?v=1',
                function: 'handleSummarize',
                context_line: TRANSCRIPT,
                pre_context: [TRANSCRIPT],
                vars: { transcript: TRANSCRIPT },
              },
            ],
          },
        },
      ],
      $exception_values: [`retrying with ${CLERK_JWT}`],
    },
  };
}

describe('scrubAnalyticsEvent', () => {
  test('keeps the route but drops query strings, fragments and page titles', () => {
    const event = scrubAnalyticsEvent(pageview());
    expect(event.properties).toEqual({
      $current_url: 'https://eavesy.com/app/meetings/01JA2B3C4D5E6F7G8H9J0K1M2N',
      $pathname: '/app/meetings/01JA2B3C4D5E6F7G8H9J0K1M2N',
      $referrer: 'https://mail.example.com/inbox',
      $browser: 'Chrome',
      $set_once: { $initial_current_url: 'https://eavesy.com/sign-up' },
    });
  });

  test('scrubs exception text and strips source context from frames', () => {
    const event = scrubAnalyticsEvent(exceptionEvent());
    const serialized = JSON.stringify(event);
    for (const secret of [ANTHROPIC_KEY, BEARER, 'eavesy_device_', CLERK_JWT, EMAIL, 'nt_0123', 'marketing budget']) {
      expect(serialized).not.toContain(secret);
    }
    const [exception] = event.properties.$exception_list;
    expect(exception.value).toBe('upstream rejected Bearer [token] for [email] with [api-key]');
    expect(exception.stacktrace.frames).toEqual([
      { filename: 'https://eavesy.com/assets/app.js', function: 'handleSummarize' },
    ]);
    expect(event.properties.$exception_values).toEqual(['retrying with [jwt]']);
  });

  test('redactPath hides MCP token paths', () => {
    const event = scrubAnalyticsEvent(
      { event: '$exception', properties: { $current_url: 'https://mcp.eavesy.com/sometoken123/rpc' } },
      { redactPath: true },
    );
    expect(event.properties.$current_url).toBe('https://mcp.eavesy.com/[redacted]');
  });
});

describe('exceptionList', () => {
  test('keeps the type, scrubbed message and stack frames, oldest call first', () => {
    const error = new TypeError(`could not summarise for ${EMAIL}`);
    error.stack = [
      `TypeError: could not summarise for ${EMAIL}`,
      '    at summarize (index.js:10:5)',
      '    at async handler (index.js:3:1)',
      '    at node_modules/hono/dist/router.js:1:2',
    ].join('\n');
    const [exception] = exceptionList(error, { handled: false });
    expect(exception.type).toBe('TypeError');
    expect(exception.value).toBe('could not summarise for [email]');
    expect(exception.mechanism).toEqual({ handled: false, synthetic: false });
    expect(exception.stacktrace?.frames.map((frame) => [frame.function, frame.in_app])).toEqual([
      [undefined, false],
      ['async handler', true],
      ['summarize', true],
    ]);
  });

  test('wraps non-errors', () => {
    expect(exceptionList('boom', { handled: true })[0]).toMatchObject({ type: 'Error', value: 'boom' });
  });
});

describe('scrubValue', () => {
  test('filters content and credential keys, keeps ids and counts', () => {
    expect(
      scrubValue({
        job: { kind: 'summarize', meetingId: '01JA2B3C4D5E6F7G8H9J0K1M2N' },
        transcript: TRANSCRIPT,
        summary: 'Decided to cut budget',
        attempts: 3,
        userId: 'user_2abc',
      }),
    ).toEqual({
      job: { kind: 'summarize', meetingId: '01JA2B3C4D5E6F7G8H9J0K1M2N' },
      transcript: '[filtered]',
      summary: '[filtered]',
      attempts: 3,
      userId: 'user_2abc',
    });
  });
});

describe('content-bearing messages', () => {
  test('drops model output that follows a known prefix', () => {
    expect(scrubText('summary was not valid JSON: {"tldr":"We agreed to lay off the design team"')).toBe(
      'summary was not valid JSON [content removed]',
    );
    expect(scrubText('summary was not valid JSON (len=812)')).toBe('summary was not valid JSON (len=812)');
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

  test('does not mangle ordinary ids or versions', () => {
    expect(scrubText('meeting 01JA2B3C4D5E6F7G8H9J0K1M2N at v0.1.9')).toBe('meeting 01JA2B3C4D5E6F7G8H9J0K1M2N at v0.1.9');
  });
});
