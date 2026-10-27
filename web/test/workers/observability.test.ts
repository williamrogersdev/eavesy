import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withErrorReporting } from '../../src/server/observability';

type Fetch = (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;

interface Sent {
  url: string;
  body: { api_key: string; event: string; distinct_id: string; properties: Record<string, unknown> };
}

function captureOutbound(): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 200 });
  });
  return sent;
}

afterEach(() => vi.restoreAllMocks());

// Drives the wrapper inside workerd and inspects exactly the request that
// would leave the Worker for PostHog.
describe('Worker error reporting', () => {
  it('sends the message, route and release but no secrets or content', async () => {
    const sent = captureOutbound();
    const env = { POSTHOG_KEY: 'phc_test', RELEASE: 'abc1234', ENVIRONMENT: 'test' };
    const handler = withErrorReporting<typeof env>({ service: 'web' }, {
      async fetch(request: Request): Promise<Response> {
        const body = await request.text();
        throw new Error(
          `summary failed for dana@example.com using sk-ant-api03-Zx9yQ8wV7uT6sR5qP4oN3mL2kJ1iH0gF after ${body.length} chars`,
        );
      },
    });

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
    await expect((handler.fetch as Fetch)(request, env, ctx)).rejects.toThrow();
    await waitOnExecutionContext(ctx);

    expect(sent).toHaveLength(1);
    const [{ url, body }] = sent;
    expect(url).toBe('https://us.i.posthog.com/i/v0/e/');
    expect(body.api_key).toBe('phc_test');
    expect(body.event).toBe('$exception');
    expect(body.properties).toMatchObject({
      service: 'web',
      release: 'abc1234',
      environment: 'test',
      method: 'POST',
      $current_url: 'https://eavesy.com/api/meetings/01JA2B3C4D5E6F7G8H9J0K1M2N/summary',
      $process_person_profile: false,
    });
    const [exception] = body.properties.$exception_list as Array<{ value: string; mechanism: unknown }>;
    expect(exception.value).toBe('summary failed for [email] using [api-key] after 60 chars');
    expect(exception.mechanism).toEqual({ handled: false, synthetic: false });
    const serialized = JSON.stringify(body);
    for (const leaked of ['marketing budget', 'eavesy_device_', '__session', 'nt_0123', 'dana@example.com']) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('sends nothing without a key', async () => {
    const sent = captureOutbound();
    const handler = withErrorReporting({ service: 'web' }, {
      async fetch(): Promise<Response> {
        throw new Error('boom');
      },
    });
    const ctx = createExecutionContext();
    await expect((handler.fetch as Fetch)(new Request('https://eavesy.com/'), {}, ctx)).rejects.toThrow();
    await waitOnExecutionContext(ctx);
    expect(sent).toHaveLength(0);
  });

  it('never sends the MCP token from the path', async () => {
    const sent = captureOutbound();
    const token = 'nt_0123456789abcdef0123456789abcdef';
    const handler = withErrorReporting({ service: 'mcp', redactPath: true }, {
      async fetch(): Promise<Response> {
        throw new Error('tool call failed');
      },
    });
    const ctx = createExecutionContext();
    const request = new Request(`https://mcp.eavesy.com/${token}`, {
      method: 'POST',
      headers: { 'user-agent': 'Claude-Desktop/1.0' },
    });
    await (handler.fetch as Fetch)(request, { POSTHOG_KEY: 'phc_test' }, ctx).catch(() => undefined);
    await waitOnExecutionContext(ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0].body.properties.$current_url).toBe('https://mcp.eavesy.com/[redacted]');
    const serialized = JSON.stringify(sent[0].body);
    expect(serialized).not.toContain(token.slice(3));
    expect(serialized).not.toContain('Claude-Desktop');
  });
});
