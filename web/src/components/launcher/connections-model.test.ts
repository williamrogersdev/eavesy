import { describe, expect, test } from 'bun:test';
import type { ClaudeCodeStatus } from '@/lib/desktop/bridge';
import type { McpToken } from '@/lib/mcp-tokens';
import { claudeCodeConnected, claudeCodeStage } from './connections-model';

const NOW = 1_800_000_000_000;
const status = (over: Partial<ClaudeCodeStatus> = {}): ClaudeCodeStatus => ({ cli: '/usr/local/bin/claude', plugin: false, server: false, signIn: null, ...over });
const token = (name: string, over: Partial<McpToken> = {}): McpToken => ({
  id: name, name, createdAt: NOW - 1000, lastUsedAt: null, expiresAt: NOW + 86_400_000, canWrite: false, usesLegacyUrl: false, ...over,
});

describe('claudeCodeStage', () => {
  test('walks from not added to signed in, as Claude Code reports it', () => {
    expect(claudeCodeStage(true, null, null, NOW)).toBe('checking');
    expect(claudeCodeStage(true, status({ cli: null }), null, NOW)).toBe('no-cli');
    expect(claudeCodeStage(true, status(), null, NOW)).toBe('not-added');
    expect(claudeCodeStage(true, status({ plugin: true, signIn: 'needsSignIn' }), null, NOW)).toBe('needs-sign-in');
    expect(claudeCodeStage(true, status({ plugin: true, signIn: 'connected' }), null, NOW)).toBe('connected');
    expect(claudeCodeStage(true, status({ server: true, signIn: 'connected' }), null, NOW)).toBe('connected');
  });

  test('a Claude Code sign-in on the account counts only when Claude Code itself can’t say', () => {
    const tokens = [token('Claude Code (eavesy)')];
    expect(claudeCodeStage(true, status({ plugin: true, signIn: 'unknown' }), tokens, NOW)).toBe('connected');
    // Another Mac's sign-in doesn't make this one connected.
    expect(claudeCodeStage(true, status({ plugin: true, signIn: 'needsSignIn' }), tokens, NOW)).toBe('needs-sign-in');
    // A check that ran and failed is about this Mac too.
    expect(claudeCodeStage(true, status({ plugin: true, signIn: 'failed' }), tokens, NOW)).toBe('needs-sign-in');
    expect(claudeCodeStage(true, status(), tokens, NOW)).toBe('not-added');
    const expired = [token('Claude Code', { expiresAt: NOW - 1 })];
    expect(claudeCodeStage(true, status({ plugin: true, signIn: 'unknown' }), expired, NOW)).toBe('needs-sign-in');
    expect(claudeCodeStage(true, status({ plugin: true, signIn: 'unknown' }), [token('ChatGPT')], NOW)).toBe('needs-sign-in');
  });

  test('the web only ever shows the steps', () => {
    expect(claudeCodeStage(false, status({ plugin: true, signIn: 'connected' }), null, NOW)).toBe('web');
  });
});

describe('claudeCodeConnected: Claude Code is listed in one place', () => {
  test('in the app, only when this Mac is signed in', () => {
    expect(claudeCodeConnected('connected', null, NOW)).toBe(true);
    expect(claudeCodeConnected('needs-sign-in', [token('Claude Code')], NOW)).toBe(false);
    expect(claudeCodeConnected('checking', [token('Claude Code')], NOW)).toBe(false);
  });

  test('on the web, when the account has a live Claude Code sign-in', () => {
    expect(claudeCodeConnected('web', [token('claude-code')], NOW)).toBe(true);
    expect(claudeCodeConnected('web', [token('Claude')], NOW)).toBe(false);
    expect(claudeCodeConnected('web', [token('Claude Code', { expiresAt: NOW - 1 })], NOW)).toBe(false);
    expect(claudeCodeConnected('web', null, NOW)).toBe(false);
  });
});
