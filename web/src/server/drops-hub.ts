import { DurableObject } from 'cloudflare:workers';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { reportError } from '@/server/observability';

const TICKET_TTL_MS = 60_000;
const TICKET_PREFIX = 'ticket:';

/**
 * One instance per user (addressed by user id). Every open tab / desktop
 * window holds a hibernatable WebSocket here; the API calls `broadcast` after a
 * drop is written so the user's other devices see it immediately.
 *
 * Clerk auth only runs inside the TanStack handler, so sockets are admitted with
 * a one-time ticket: an authenticated request asks this object to mint one,
 * then the browser opens /api/drops/live?u=<userId>&ticket=<t>, which the
 * worker entry routes straight here.
 */
export class DropsHub extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async issueTicket(): Promise<string> {
    const now = Date.now();
    const stale = await this.ctx.storage.list<number>({ prefix: TICKET_PREFIX });
    const expired = [...stale].filter(([, exp]) => exp < now).map(([key]) => key);
    if (expired.length) await this.ctx.storage.delete(expired);

    const ticket = crypto.randomUUID();
    await this.ctx.storage.put(TICKET_PREFIX + ticket, now + TICKET_TTL_MS);
    return ticket;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
    const key = TICKET_PREFIX + ticket;
    const exp = ticket ? await this.ctx.storage.get<number>(key) : undefined;
    if (!exp || exp < Date.now()) return new Response('invalid ticket', { status: 401 });
    await this.ctx.storage.delete(key);

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  broadcast(message: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Socket is already closing; the close handler cleans it up.
      }
    }
  }

  webSocketMessage(): void {
    // Clients only send keepalive pings, which the auto-response handles.
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}

type HubNamespace = DurableObjectNamespace<DropsHub>;

export function hubNamespace(env: unknown): HubNamespace {
  const ns = (env as { DROPS_HUB?: HubNamespace }).DROPS_HUB;
  if (!ns) throw new Error('DROPS_HUB binding missing — see wrangler.jsonc');
  return ns;
}

function hub(userId: string) {
  const ns = hubNamespace(getCloudflareContext().env);
  return ns.get(ns.idFromName(userId));
}

export async function issueLiveTicket(userId: string): Promise<string> {
  return await hub(userId).issueTicket();
}

export type HubEvent =
  | { type: 'drop'; drop: unknown; origin: string | null }
  | { type: 'delete'; id: string; origin: string | null };

/** Best-effort fan-out: a failed broadcast never fails the write that caused it. */
export async function publish(userId: string, event: HubEvent): Promise<void> {
  try {
    await hub(userId).broadcast(JSON.stringify(event));
  } catch (error) {
    reportError('drops broadcast failed', error, { userId });
  }
}
