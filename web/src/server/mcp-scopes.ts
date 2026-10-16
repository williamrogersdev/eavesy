/**
 * What an MCP connection may do. Every MCP tool declares the scope it needs; a
 * connection only sees and can only call tools within its scopes. No imports:
 * the MCP Worker uses this module directly.
 */

export const MCP_SCOPES = ['read', 'write'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

function isScope(value: unknown): value is McpScope {
  return typeof value === 'string' && (MCP_SCOPES as readonly string[]).includes(value);
}

/**
 * Scopes from a stored `scopes_json`. Unknown entries are dropped, and anything
 * unreadable falls back to read-only: a bad row never grants more.
 */
export function parseMcpScopes(json: string | null | undefined): McpScope[] {
  let value: unknown;
  try {
    value = JSON.parse(json ?? '');
  } catch {
    return ['read'];
  }
  if (!Array.isArray(value)) return ['read'];
  const scopes = MCP_SCOPES.filter((scope) => value.some((entry: unknown) => isScope(entry) && entry === scope));
  return scopes.length ? scopes : ['read'];
}

/** Scopes a user asked for when creating a connection. Read is always included. */
export function normalizeMcpScopes(requested: readonly unknown[] | undefined): McpScope[] {
  return MCP_SCOPES.filter((scope) => scope === 'read' || (requested ?? []).includes(scope));
}

export function toolsForScopes<T extends { scope: McpScope }>(tools: readonly T[], scopes: readonly McpScope[]): T[] {
  return tools.filter((tool) => scopes.includes(tool.scope));
}
