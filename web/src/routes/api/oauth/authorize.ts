import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { resolveActor } from '@/server/auth';
import {
  approveAuthorization,
  authorizationParams,
  denyAuthorization,
  validateAuthorization,
} from '@/server/mcp-oauth';
import { MCP_SCOPES } from '@/server/mcp-scopes';
import { MCP_SERVER_URL } from '@/server/mcp-token-policy';

const param = z.string().max(2_000).nullish();
const decisionSchema = z.object({
  params: z.object({
    client_id: param,
    redirect_uri: param,
    response_type: param,
    code_challenge: param,
    code_challenge_method: param,
    scope: param,
    state: param,
  }),
  decision: z.enum(['approve', 'deny']),
  scopes: z.array(z.enum(MCP_SCOPES)).max(MCP_SCOPES.length).default(['read']),
});

/**
 * The consent step of MCP OAuth. The MCP Worker's `/authorize` validates the
 * request and sends the browser to `/connect/mcp`; that page asks this route
 * what is being requested (GET), then posts the user's answer (POST), which
 * re-validates everything and returns where to send the browser next.
 */
export const Route = createFileRoute('/api/oauth/authorize')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const validated = await validateAuthorization(getDb(), authorizationParams(new URL(request.url).searchParams));
        if (!validated.ok) return Response.json({ error: validated.error.error_description ?? validated.error.error }, { status: 400 });
        return Response.json({
          clientName: validated.clientName,
          redirectHost: redirectLabel(validated.redirectUri),
          scopes: validated.scopes,
        });
      },
      POST: async ({ request }) => {
        let userId: string;
        try {
          ({ userId } = await resolveActor());
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        // JSON only, from this origin: a cross-site form can't approve for the user.
        const origin = request.headers.get('origin');
        if (!request.headers.get('content-type')?.includes('application/json') || (origin && origin !== new URL(request.url).origin)) {
          return Response.json({ error: 'forbidden' }, { status: 403 });
        }
        const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });

        const db = getDb();
        const validated = await validateAuthorization(db, parsed.data.params);
        if (!validated.ok) {
          return validated.redirect
            ? Response.json({ redirectTo: validated.redirectTo })
            : Response.json({ error: validated.error.error_description ?? validated.error.error }, { status: 400 });
        }
        const redirectTo =
          parsed.data.decision === 'approve'
            ? await approveAuthorization(db, { request: validated, userId, scopes: parsed.data.scopes, issuer: MCP_SERVER_URL })
            : denyAuthorization(validated, MCP_SERVER_URL);
        return Response.json({ redirectTo });
      },
    },
  },
});

/** What the consent screen shows for where the user is sent: a host, or an app's scheme. */
function redirectLabel(uri: string): string {
  const url = new URL(uri);
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : `${url.protocol}//`;
}
