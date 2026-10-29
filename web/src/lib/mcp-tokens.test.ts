import { describe, expect, test } from 'bun:test';
import { CLAUDE_CODE_AGENT_PROMPT, CLAUDE_CODE_PLUGIN_CLI, CLAUDE_CODE_SIGN_IN, isClaudeCodeToken, MCP_AGENT_PROMPT, MCP_URL } from './mcp-tokens';

describe('setup prompts', () => {
  test('the Claude Code prompt runs the same commands as the button, and leaves the browser sign-in to you', () => {
    for (const command of CLAUDE_CODE_PLUGIN_CLI.split(' && ')) expect(CLAUDE_CODE_AGENT_PROMPT).toContain(command);
    expect(CLAUDE_CODE_AGENT_PROMPT).toContain(CLAUDE_CODE_SIGN_IN);
    expect(CLAUDE_CODE_AGENT_PROMPT).toContain("don't do it yourself");
    expect(CLAUDE_CODE_AGENT_PROMPT.split('\n').filter((line) => /^\d\. /.test(line))).toHaveLength(5);
  });

  test('the generic prompt names the server and says there is no token', () => {
    expect(MCP_AGENT_PROMPT).toContain(MCP_URL);
    expect(MCP_AGENT_PROMPT).toContain('Name: eavesy');
    expect(MCP_AGENT_PROMPT).toContain('OAuth');
  });
});

test('Claude Code sign-ins are told apart from Claude and others', () => {
  for (const name of ['Claude Code', 'claude-code', 'Claude Code (plugin:eavesy:eavesy)', 'claude_code']) expect(isClaudeCodeToken({ name })).toBe(true);
  for (const name of ['Claude', 'ChatGPT', 'Cursor']) expect(isClaudeCodeToken({ name })).toBe(false);
});
