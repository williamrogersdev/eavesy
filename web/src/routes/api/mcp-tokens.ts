import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as mcpRepo from '@/db/repo/mcp';
import { resolveActor } from '@/server/auth';
import { MCP_SCOPES, normalizeMcpScopes, parseMcpScopes } from '@/server/mcp-scopes';
import { MCP_SERVER_URL, mcpTokenExpiresAt } from '@/server/mcp-token-policy';

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(MCP_SCOPES)).max(MCP_SCOPES.length).optional(),
});
const revokeSchema = z.object({ id: z.string().min(1).max(100) });

const unauthenticated = () => Response.json({ error: 'unauthenticated' }, { status: 401 });

export const Route = createFileRoute('/api/mcp-tokens')({
  server: {
    handlers: {
      GET: async () => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return unauthenticated();
        }
        const rows = await mcpRepo.listForUser(getDb(), actor.userId);
        return Response.json(
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            createdAt: row.createdAt,
            lastUsedAt: row.lastUsedAt,
            // An OAuth connection lives as long as its refresh token.
            expiresAt: row.refreshExpiresAt ?? mcpTokenExpiresAt(row),
            scopes: parseMcpScopes(row.scopesJson),
            usesLegacyUrl: row.pathAuthUsedAt !== null,
          })),
        );
      },
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return unauthenticated();
        }
        const parsed = createSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const scopes = normalizeMcpScopes(parsed.data.scopes);
        const token = await mcpRepo.mintToken(getDb(), {
          userId: actor.userId,
          name: parsed.data.name,
          scopes,
        });
        return Response.json(
          {
            id: token.id,
            serverUrl: MCP_SERVER_URL,
            token: token.rawToken,
            expiresAt: token.expiresAt,
            scopes,
          },
          { status: 201 },
        );
      },
      DELETE: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return unauthenticated();
        }
        const parsed = revokeSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        await mcpRepo.revoke(getDb(), { userId: actor.userId, id: parsed.data.id });
        return Response.json({ ok: true });
      },
    },
  },
});
