import { describe, expect, it } from 'vitest';
import { deviceTags, DropsHub } from '../../src/server/drops-hub';

interface FakeSocket {
  sent: string[];
  send(message: string): void;
}

/** The parts of a Durable Object's state the hub uses, kept in memory. */
function fakeState() {
  const stored = new Map<string, unknown>();
  const sockets: { ws: FakeSocket; tags: string[] }[] = [];
  const ctx = {
    setWebSocketAutoResponse: () => undefined,
    storage: {
      list: async ({ prefix }: { prefix: string }) => new Map([...stored].filter(([key]) => key.startsWith(prefix))),
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => void stored.set(key, value),
      delete: async (keys: string | string[]) => {
        for (const key of [keys].flat()) stored.delete(key);
      },
    },
    acceptWebSocket: (_ws: unknown, tags: string[] = []) => {
      const ws: FakeSocket = { sent: [], send: (message) => void ws.sent.push(message) };
      sockets.push({ ws, tags });
    },
    getWebSockets: (tag?: string) => sockets.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws),
    getTags: (ws: FakeSocket) => sockets.find((s) => s.ws === ws)?.tags ?? [],
  };
  return { ctx, stored, sockets };
}

function hub() {
  const state = fakeState();
  // The runtime only constructs a Durable Object from real state, so the hub's
  // methods run here on an object given the in-memory state directly.
  const object = Object.create(DropsHub.prototype) as DropsHub;
  Object.defineProperty(object, 'ctx', { value: state.ctx });
  const connect = (ticket: string) =>
    object.fetch(new Request(`https://eavesy.com/api/drops/live?u=owner&ticket=${ticket}`, { headers: { upgrade: 'websocket' } }));
  return { ...state, object, connect };
}

describe('DropsHub', () => {
  it('admits a socket once per ticket', async () => {
    const { object, connect, sockets } = hub();
    const ticket = await object.issueTicket();
    expect((await connect(ticket)).status).toBe(101);
    expect((await connect(ticket)).status).toBe(401);
    expect((await connect('made-up')).status).toBe(401);
    expect(sockets).toHaveLength(1);
  });

  it('still admits a ticket stored before Mac apps connected', async () => {
    const { connect, stored, sockets } = hub();
    stored.set('ticket:old', Date.now() + 30_000);
    stored.set('ticket:expired', Date.now() - 1);
    expect((await connect('old')).status).toBe(101);
    expect((await connect('expired')).status).toBe(401);
    expect(sockets[0].tags).toEqual([]);
  });

  it('tells every Mac app but the one that made the change, and no browser tab', async () => {
    const { object, connect, sockets } = hub();
    await connect(await object.issueTicket());
    await connect(await object.issueTicket('dev_a'));
    await connect(await object.issueTicket('dev_b'));
    await connect(await object.issueTicket(''));
    const [tab, macA, macB, unnamed] = sockets.map((s) => s.ws);

    object.notifyDevices('changed', 'dev_a');
    expect(tab.sent).toEqual([]);
    expect(macA.sent).toEqual([]);
    expect(macB.sent).toEqual(['changed']);
    expect(unnamed.sent).toEqual(['changed']);

    // A change made on the web or by an agent goes to every Mac.
    object.notifyDevices('again', null);
    expect(macA.sent).toEqual(['again']);
    expect(macB.sent).toEqual(['changed', 'again']);
    expect(tab.sent).toEqual([]);
  });

  it('sends drops to tabs and Mac apps alike', async () => {
    const { object, connect, sockets } = hub();
    await connect(await object.issueTicket());
    await connect(await object.issueTicket('dev_a'));
    object.broadcast('drop');
    expect(sockets.map((s) => s.ws.sent)).toEqual([['drop'], ['drop']]);
  });

  it('tags a Mac app by its device id when it has a usable one', () => {
    expect(deviceTags(undefined)).toEqual([]);
    expect(deviceTags('')).toEqual(['device']);
    expect(deviceTags('dev_a')).toEqual(['device', 'dev:dev_a']);
    expect(deviceTags('x'.repeat(300))).toEqual(['device']);
  });
});
