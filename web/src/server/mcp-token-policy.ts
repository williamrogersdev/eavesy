/**
 * MCP token lifetime and the deprecation of tokens in the URL path. No imports:
 * the MCP Worker uses this module directly.
 */

export const MCP_SERVER_URL = 'https://mcp.eavesy.com';
export const MCP_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
/** Sliding the expiry forward costs a write, so do it at most once a day per token. */
export const MCP_TOKEN_RENEW_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Rows minted before expiry existed (no `expires_at`) get 90 days from creation. */
export function mcpTokenExpiresAt(row: { createdAt: number; expiresAt: number | null }): number {
  return row.expiresAt ?? row.createdAt + MCP_TOKEN_TTL_MS;
}

/**
 * Expiry slides: a token expires 90 days after it was last used, not after it
 * was minted. Returns the new expiry when this use should write one, else null.
 */
export function renewedMcpTokenExpiry(
  row: { createdAt: number; expiresAt: number | null },
  now: number,
): number | null {
  const next = now + MCP_TOKEN_TTL_MS;
  return next - mcpTokenExpiresAt(row) >= MCP_TOKEN_RENEW_INTERVAL_MS ? next : null;
}

/**
 * Tokens used to live in the URL (`https://mcp.eavesy.com/<token>`), where they
 * end up in client configs, logs, and history. They now go in the
 * Authorization header, but some MCP clients can only be given a URL, so
 * URL-path tokens keep working (and are logged) until the MCP Worker's
 * `MCP_ALLOW_PATH_TOKENS` variable is set to `false`.
 */
export function pathTokensAllowed(flag: string | undefined): boolean {
  return flag?.trim().toLowerCase() !== 'false';
}
