// No imports: the MCP Worker bundles this through server/mcp-oauth.ts.

/** Lowercase hex SHA-256 of `input`, the form token and code hashes are stored in. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
