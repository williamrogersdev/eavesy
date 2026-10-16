import { describe, expect, it } from 'bun:test';
import { normalizeMcpScopes, parseMcpScopes, toolsForScopes } from './mcp-scopes';

describe('parseMcpScopes', () => {
  it('reads stored scopes', () => {
    expect(parseMcpScopes('["read"]')).toEqual(['read']);
    expect(parseMcpScopes('["write","read"]')).toEqual(['read', 'write']);
  });

  it('falls back to read-only for anything it cannot read', () => {
    expect(parseMcpScopes(null)).toEqual(['read']);
    expect(parseMcpScopes('')).toEqual(['read']);
    expect(parseMcpScopes('not json')).toEqual(['read']);
    expect(parseMcpScopes('{"write":true}')).toEqual(['read']);
    expect(parseMcpScopes('[]')).toEqual(['read']);
    expect(parseMcpScopes('["admin"]')).toEqual(['read']);
  });

  it('keeps write without read when that is what was stored', () => {
    expect(parseMcpScopes('["write"]')).toEqual(['write']);
  });
});

describe('normalizeMcpScopes', () => {
  it('always includes read and ignores unknown scopes', () => {
    expect(normalizeMcpScopes(undefined)).toEqual(['read']);
    expect(normalizeMcpScopes([])).toEqual(['read']);
    expect(normalizeMcpScopes(['write'])).toEqual(['read', 'write']);
    expect(normalizeMcpScopes(['admin', 'write', 'write'])).toEqual(['read', 'write']);
  });
});

describe('toolsForScopes', () => {
  const tools = [
    { name: 'search', scope: 'read' as const },
    { name: 'send', scope: 'write' as const },
  ];

  it('hides tools outside the connection’s scopes', () => {
    expect(toolsForScopes(tools, ['read']).map((tool) => tool.name)).toEqual(['search']);
    expect(toolsForScopes(tools, ['read', 'write']).map((tool) => tool.name)).toEqual(['search', 'send']);
  });
});
