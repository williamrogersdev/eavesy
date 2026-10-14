import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import type { Envelope, Event } from '@sentry/core';
import { describe, expect, it } from 'vitest';
import { sentryOptions, withSentry } from '../../src/server/observability';

// Drives the real @sentry/cloudflare SDK inside workerd with a capturing
// transport, so the test sees exactly the event that would leave the Worker.
describe('Worker error reporting', () => {
  it('sends the message, route and release but no secrets or content', async () => {
    const sent: Event[] = [];
    const env = {
      SENTRY_DSN: 'https://public@o1.ingest.sentry.io/1',
      SENTRY_RELEASE: 'abc1234',
      SENTRY_ENVIRONMENT: 'test',
    };
    const handler = withSentry(
      (runtimeEnv: typeof env) => ({
        ...sentryOptions(runtimeEnv, { service: 'web' }),
        tracesSampleRate: 0,
        transport: () => ({
          send: async (envelope: Envelope) => {
            for (const [header, payload] of envelope[1]) {
              if (header.type === 'event') sent.push(payload as Event);
            }
            return {};
          },
          flush: async () => true,
        }),
      }),
      {
        async fetch(request: Request): Promise<Response> {
          const body = await request.text();
          throw new Error(
            `summary failed for dana@example.com using sk-ant-api03-Zx9yQ8wV7uT6sR5qP4oN3mL2kJ1iH0gF after ${body.length} chars`,
          );
        },
      },
    );

    const ctx = createExecutionContext();
    const request = new Request(
      'https://eavesy.com/api/meetings/01JA2B3C4D5E6F7G8H9J0K1M2N/summary?token=nt_0123456789abcdef0123',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer eavesy_device_kq2N0dS8mX4bV7cZ1aP9wE3rT6yU5iO0lK8jH2gF4dS',
          cookie: '__session=secret',
        },
        body: 'Dana: we should cut the Q3 marketing budget by forty percent',
      },
    );
    await expect(
      (handler.fetch as (r: Request, e: typeof env, c: ExecutionContext) => Promise<Response>)(
        request,
        env,
        ctx,
      ),
    ).rejects.toThrow();
    await waitOnExecutionContext(ctx);

    expect(sent).toHaveLength(1);
    const [event] = sent;
    expect(event.exception?.values?.[0]?.value).toBe(
      'summary failed for [email] using [api-key] after 60 chars',
    );
    expect(event.release).toBe('abc1234');
    expect(event.environment).toBe('test');
    expect(event.tags?.service).toBe('web');
    expect(event.request).toEqual({
      url: 'https://eavesy.com/api/meetings/01JA2B3C4D5E6F7G8H9J0K1M2N/summary',
      method: 'POST',
    });
    const serialized = JSON.stringify(event);
    for (const leaked of ['marketing budget', 'eavesy_device_', '__session', 'nt_0123', 'dana@example.com']) {
      expect(serialized).not.toContain(leaked);
    }
  });
});
