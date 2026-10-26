import { isRecord } from '@/lib/json';

/** The hosted MCP server agents add by URL. They sign in with OAuth, so there is no token to paste. */
export const MCP_URL = 'https://mcp.eavesy.com';
/** `--scope user` so it works in every folder, not just the one you ran it in. */
export const CLAUDE_CODE_ADD = `claude mcp add --scope user --transport http eavesy ${MCP_URL}`;
/** The plugin from your terminal, the same thing the desktop app's button runs. */
export const CLAUDE_CODE_PLUGIN_CLI = 'claude plugin marketplace add williamrogersdev/eavesy && claude plugin install eavesy@eavesy --scope user';

/** An app the account approved (OAuth) or a token made by hand, as `/api/mcp-tokens` lists it. */
export interface McpToken {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt?: number | null;
  expiresAt: number | null;
  canWrite: boolean;
  usesLegacyUrl: boolean;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export function parseMcpTokens(value: unknown): McpToken[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): McpToken[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.createdAt !== 'number'
    ) {
      return [];
    }
    return [{
      id: item.id,
      name: item.name,
      createdAt: item.createdAt,
      lastUsedAt: nullableNumber(item.lastUsedAt),
      expiresAt: nullableNumber(item.expiresAt),
      canWrite: Array.isArray(item.scopes) && item.scopes.includes('write'),
      usesLegacyUrl: item.usesLegacyUrl === true,
    }];
  });
}
