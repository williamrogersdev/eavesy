import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import type { Envelope } from '@sentry/core';
import { describe, expect, it } from 'vitest';
import { sentryOptions, withSentry } from '../../src/server/observability';

type Fetch = (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;

// Separate file: the Sentry client is created once per isolate, and this one
// needs the MCP Worker's options (redactPath) with every trace sampled.
describe('MCP Worker error reporting', () => {
  it('never sends the MCP token in a sampled transaction or error', async () => {
    const items: string[] = [];
    const token = 'nt_0123456789abcdef0123456789abcdef';
    const env = { SENTRY_DSN: 'https://public@o1.ingest.sentry.io/1', SENTRY_RELEASE: 'abc1234' };
    const handler = withSentry(
      (runtimeEnv: typeof env) => ({
        ...sentryOptions(runtimeEnv, { service: 'mcp', redactPath: true }),
        tracesSampleRate: 1,
        transport: () => ({
          send: async (envelope: Envelope) => {
            for (const [header, payload] of envelope[1]) {
              items.push(`${header.type}:${JSON.stringify(payload)}`);
            }
            return {};
          },
          flush: async () => true,
        }),
      }),
      {
        async fetch(request: Request): Promise<Response> {
          if (request.method === 'POST') throw new Error('tool call failed');
          return new Response('ok');
        },
      },
    );

    for (const method of ['GET', 'POST']) {
      const ctx = createExecutionContext();
      const request = new Request(`https://mcp.eavesy.com/${token}`, {
        method,
        headers: { 'user-agent': 'Claude-Desktop/1.0' },
      });
      await (handler.fetch as Fetch)(request, env, ctx).catch(() => undefined);
      await waitOnExecutionContext(ctx);
    }

    expect(items.some((item) => item.startsWith('span:'))).toBe(true);
    expect(items.some((item) => item.startsWith('event:'))).toBe(true);
    for (const item of items) {
      expect(item).not.toContain(token.slice(3));
      expect(item).not.toContain('Claude-Desktop');
    }
  });
});
