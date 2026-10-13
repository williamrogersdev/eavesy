import { afterEach, expect, test } from 'bun:test';
import { createResource } from './shared-resource';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('concurrent refreshes share one request', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Response.json({ n: calls });
  }) as unknown as typeof fetch;
  const resource = createResource('/api/x', (json) => json as { n: number });
  await Promise.all([resource.refresh(), resource.refresh(), resource.refresh()]);
  expect(calls).toBe(1);
  await resource.refresh();
  expect(calls).toBe(2);
});
