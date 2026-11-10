import { DurableObject } from 'cloudflare:workers';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { reportError } from '@/server/observability';

const TICKET_TTL_MS = 60_000;
const TICKET_PREFIX = 'ticket:';

const DEVICE_TAG = 'device';
const DEVICE_ID_TAG_PREFIX = 'dev:';
/** The longest tag a hibernatable socket may carry. */
const MAX_TAG_CHARS = 256;

/** What a ticket admits: a browser tab, or a paired Mac app. */
interface Ticket {
  exp: number;
  /** Set for a Mac app's socket: `''` when the app's device has no id. */
  device?: string;
}

/** Tickets minted before Mac apps connected were stored as their expiry alone. */
function readTicket(stored: Ticket | number | undefined): Ticket | undefined {
  return typeof stored === 'number' ? { exp: stored } : stored;
}

/**
 * One instance per user (addressed by user id). Every open tab and every
 * running Mac app holds a hibernatable WebSocket here. The API calls
 * `broadcast` after a drop is written so the user's other devices see it
 * immediately, and `notifyDevices` after a note or image is saved, so the
 * user's other Macs fetch it now instead of at their next check.
 *
 * Clerk auth only runs inside the TanStack handler, so sockets are admitted with
 * a one-time ticket: an authenticated request asks this object to mint one,
 * then the client opens /api/drops/live?u=<userId>&ticket=<t>, which the
 * worker entry routes straight here.
 */
export class DropsHub extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** `device` is given for a Mac app: its device id, or `''` when it has none. */
  async issueTicket(device?: string): Promise<string> {
    const now = Date.now();
    const stale = await this.ctx.storage.list<Ticket | number>({ prefix: TICKET_PREFIX });
    const expired = [...stale].filter(([, stored]) => (readTicket(stored)?.exp ?? 0) < now).map(([key]) => key);
    if (expired.length) await this.ctx.storage.delete(expired);

    const ticket = crypto.randomUUID();
    const stored: Ticket = { exp: now + TICKET_TTL_MS, ...(device === undefined ? {} : { device }) };
    await this.ctx.storage.put(TICKET_PREFIX + ticket, stored);
    return ticket;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
    const key = TICKET_PREFIX + ticket;
    const admitted = ticket ? readTicket(await this.ctx.storage.get<Ticket | number>(key)) : undefined;
    if (!admitted || admitted.exp < Date.now()) return new Response('invalid ticket', { status: 401 });
    await this.ctx.storage.delete(key);

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], deviceTags(admitted.device));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * Tells the user's Mac apps that something changed in the cloud, except the
   * Mac that made the change. Browser tabs are left out: they don't keep a
   * local copy to bring up to date.
   */
  notifyDevices(message: string, exceptDevice: string | null): void {
    const skip = exceptDevice ? DEVICE_ID_TAG_PREFIX + exceptDevice : null;
    for (const ws of this.ctx.getWebSockets(DEVICE_TAG)) {
      if (skip && this.ctx.getTags(ws).includes(skip)) continue;
      try {
        ws.send(message);
      } catch {
        // Socket is already closing; the close handler cleans it up.
      }
    }
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

/** The tags a socket is accepted with: none for a browser tab. */
export function deviceTags(device: string | undefined): string[] {
  if (device === undefined) return [];
  const id = DEVICE_ID_TAG_PREFIX + device;
  // A device with no id, or one too long to tag, is told about every change, its own included.
  return device && id.length <= MAX_TAG_CHARS ? [DEVICE_TAG, id] : [DEVICE_TAG];
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

/** A ticket for a Mac app's socket, which is told when the user's captures change. */
export async function issueDeviceLiveTicket(userId: string, deviceId: string | undefined): Promise<string> {
  return await hub(userId).issueTicket(deviceId ?? '');
}

/** What changed in the cloud, for a Mac app to fetch. */
export type SyncEvent = { type: 'sync'; what: 'captures' };

/**
 * Tells the user's Mac apps to fetch now: a note or image was saved, edited or
 * deleted. `fromDevice` is the Mac that made the change, which already has it.
 * Best effort: a Mac that misses it still finds the change at its next check.
 */
export async function publishSync(userId: string, fromDevice: string | null | undefined): Promise<void> {
  try {
    const event: SyncEvent = { type: 'sync', what: 'captures' };
    await hub(userId).notifyDevices(JSON.stringify(event), fromDevice ?? null);
  } catch (error) {
    reportError('device sync notice failed', error, { userId });
  }
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
