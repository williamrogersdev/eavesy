import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../client';
import { decode, encode } from '../codec';
import { pid } from '../ids';
import { mcpTokens } from '../schema';
import { MCP_TOKEN_TTL_MS, mcpTokenExpiresAt, renewedMcpTokenExpiry } from '@/server/mcp-token-policy';

export type Scope = 'read' | 'write';

const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function mintToken(
  db: AppDb,
  args: { userId: string; name: string; scopes?: Scope[] },
): Promise<{ id: string; rawToken: string; expiresAt: number }> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const rawToken =
    'nt_' +
    Array.from(buf)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  const tokenHash = await sha256Hex(rawToken);

  const id = pid('mcp');
  const createdAt = Date.now();
  const expiresAt = createdAt + MCP_TOKEN_TTL_MS;
  await db.insert(mcpTokens).values({
    id,
    userId: args.userId,
    tokenHash,
    name: args.name,
    scopesJson: encode(args.scopes ?? ['read']),
    createdAt,
    expiresAt,
  });
  return { id, rawToken, expiresAt };
}

export async function listForUser(db: AppDb, userId: string) {
  return await db
    .select()
    .from(mcpTokens)
    .where(and(eq(mcpTokens.userId, userId), isNull(mcpTokens.revokedAt)));
}

export async function revoke(db: AppDb, args: { userId: string; id: string }) {
  await db
    .update(mcpTokens)
    .set({ revokedAt: Date.now() })
    .where(and(eq(mcpTokens.id, args.id), eq(mcpTokens.userId, args.userId)));
}

export async function resolveToken(db: AppDb, rawToken: string) {
  const tokenHash = await sha256Hex(rawToken);
  const rows = await db
    .select()
    .from(mcpTokens)
    .where(eq(mcpTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt || mcpTokenExpiresAt(row) <= Date.now()) return null;
  const now = Date.now();
  const expiresAt = renewedMcpTokenExpiry(row, now);
  if (!row.lastUsedAt || now - row.lastUsedAt > LAST_USED_RESOLUTION_MS || expiresAt) {
    await db
      .update(mcpTokens)
      .set(expiresAt ? { lastUsedAt: now, expiresAt } : { lastUsedAt: now })
      .where(eq(mcpTokens.id, row.id));
  }
  return {
    tokenId: row.id,
    userId: row.userId,
    scopes: decode<Scope[]>(row.scopesJson, ['read']),
  };
}
