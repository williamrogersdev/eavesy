import { accountCall, isDesktop } from '@/lib/desktop/bridge';
import { parseMcpTokens, type McpToken } from '@/lib/mcp-tokens';

/** Calls `/api/mcp-tokens` as this Mac when in the app, or as the signed-in browser. */
async function call(method: 'GET' | 'DELETE', body?: unknown): Promise<unknown> {
  if (isDesktop()) return await accountCall(method, '/api/mcp-tokens', body);
  const response = await fetch('/api/mcp-tokens', {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error('Couldn’t reach eavesy.com. Try again.');
  return await response.json().catch(() => null);
}

export async function listMcpTokens(): Promise<McpToken[]> {
  return parseMcpTokens(await call('GET'));
}

export async function revokeMcpToken(id: string): Promise<void> {
  await call('DELETE', { id });
}
