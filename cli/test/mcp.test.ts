import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { handleMessage } from '../src/mcp';

const FIXTURE = join(import.meta.dir, 'fixtures', 'Recordings');
const call = (name: string, args: Record<string, unknown>) =>
  handleMessage(FIXTURE, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as {
    result: { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
  };
const parsed = (response: ReturnType<typeof call>) => JSON.parse(response.result.content[0].text!);

describe('handleMessage', () => {
  test('initialize negotiates a supported protocol version', () => {
    const res = handleMessage(FIXTURE, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(res.result.protocolVersion).toBe('2025-06-18');
    expect(res.result.serverInfo.name).toBe('eavesy-local');
    const unknown = handleMessage(FIXTURE, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '1999-01-01' } }) as {
      result: { protocolVersion: string };
    };
    expect(unknown.result.protocolVersion).toBe('2025-11-25');
  });

  test('notifications get no response; unknown methods get -32601', () => {
    expect(handleMessage(FIXTURE, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(handleMessage(FIXTURE, { jsonrpc: '2.0', id: 9, method: 'resources/list' })).toMatchObject({ id: 9, error: { code: -32601 } });
    expect(handleMessage(FIXTURE, 'nope')).toMatchObject({ error: { code: -32600 } });
  });

  test('tools/list lists the three read-only tools', () => {
    const res = handleMessage(FIXTURE, { jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
    expect(res.result.tools.map((t) => t.name)).toEqual(['search_captures', 'get_capture', 'recent_captures']);
  });

  test('search_captures finds a local clipboard note', () => {
    const body = parsed(call('search_captures', { query: 'webhook' }));
    expect(body.root).toBe(FIXTURE);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ kind: 'note', matchedIn: 'note.md' });
  });

  test('recent_captures filters by kind', () => {
    const body = parsed(call('recent_captures', { kind: 'screenshot' }));
    expect(body.results.map((r: { kind: string }) => r.kind)).toEqual(['screenshot']);
  });

  test('get_capture attaches screenshots as images', () => {
    const res = call('get_capture', { id: '5b9e1c7a-0d2f-4a8e-9c1b-2f6d3e4a5b6c' });
    expect(res.result.isError).toBeUndefined();
    const [meta, image] = res.result.content;
    expect(JSON.parse(meta.text!).files[0]).toMatchObject({ name: 'screenshot.png', role: 'media' });
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(image.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');

    const textOnly = call('get_capture', { id: '5b9e1c7a-0d2f-4a8e-9c1b-2f6d3e4a5b6c', include_images: false });
    expect(textOnly.result.content).toHaveLength(1);
  });

  test('get_capture returns meeting text', () => {
    const body = parsed(call('get_capture', { id: 'meeting-design-review' }));
    expect(body.text['transcript.md']).toContain('feature flag');
  });

  test('bad arguments are tool errors the model can read', () => {
    expect(call('get_capture', { id: 'missing' }).result).toMatchObject({ isError: true });
    expect(call('search_captures', {}).result).toMatchObject({ isError: true });
    expect(call('recent_captures', { kind: 'podcast' }).result).toMatchObject({ isError: true });
    expect(handleMessage(FIXTURE, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete_everything' } })).toMatchObject({
      error: { code: -32602 },
    });
  });
});

describe('eavesy mcp over stdio', () => {
  test('answers a client session line by line', async () => {
    const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'bin.ts'), 'mcp', '--root', FIXTURE], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_captures', arguments: { query: 'onboarding' } } },
    ];
    proc.stdin.write(messages.map((m) => JSON.stringify(m)).join('\n') + '\nnot json\n');
    await proc.stdin.end();
    const lines = (await new Response(proc.stdout).text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(await proc.exited).toBe(0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ id: 1, result: { protocolVersion: '2025-11-25' } });
    expect(JSON.parse(lines[1].result.content[0].text).results[0].id).toBe('meeting-design-review');
    expect(lines[2]).toMatchObject({ id: null, error: { code: -32700 } });
  });
});
