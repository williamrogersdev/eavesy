import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as mcpRepo from '@/db/repo/mcp';
import { resolveActor } from '@/server/auth';
import { MCP_SERVER_URL, mcpTokenExpiresAt } from '@/server/mcp-token-policy';

const createSchema = z.object({ name: z.string().trim().min(1).max(100) });
const revokeSchema = z.object({ id: z.string().min(1).max(100) });

export const Route = createFileRoute('/api/mcp-tokens')({
  server: {
    handlers: {
      GET: async () => {
        try {
          const actor = await resolveActor();
          const rows = await mcpRepo.listForUser(getDb(), actor.userId);
          return Response.json(
            rows.map((row) => ({
              id: row.id,
              name: row.name,
              createdAt: row.createdAt,
              lastUsedAt: row.lastUsedAt,
              expiresAt: mcpTokenExpiresAt(row),
              usesLegacyUrl: row.pathAuthUsedAt !== null,
            })),
          );
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
      },
      POST: async ({ request }) => {
        try {
          const actor = await resolveActor();
          const body = createSchema.parse(await request.json().catch(() => null));
          const token = await mcpRepo.mintToken(getDb(), {
            userId: actor.userId,
            name: body.name,
            scopes: ['read'],
          });
          return Response.json(
            {
              id: token.id,
              serverUrl: MCP_SERVER_URL,
              token: token.rawToken,
              expiresAt: token.expiresAt,
            },
            { status: 201 },
          );
        } catch (error) {
          if (error instanceof z.ZodError) return Response.json({ error: 'invalid_request' }, { status: 400 });
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
      },
      DELETE: async ({ request }) => {
        try {
          const actor = await resolveActor();
          const body = revokeSchema.parse(await request.json().catch(() => null));
          await mcpRepo.revoke(getDb(), { userId: actor.userId, id: body.id });
          return Response.json({ ok: true });
        } catch (error) {
          if (error instanceof z.ZodError) return Response.json({ error: 'invalid_request' }, { status: 400 });
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
      },
    },
  },
});
