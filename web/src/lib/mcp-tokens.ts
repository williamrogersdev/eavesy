import { isRecord } from '@/lib/json';

/** The hosted MCP server agents add by URL. They sign in with OAuth, so there is no token to paste. */
export const MCP_URL = 'https://mcp.eavesy.com';
/** `--scope user` so it works in every folder, not just the one you ran it in. */
export const CLAUDE_CODE_ADD = `claude mcp add --scope user --transport http eavesy ${MCP_URL}`;
/** The plugin from your terminal, the same thing the desktop app's button runs. */
export const CLAUDE_CODE_PLUGIN_CLI = 'claude plugin marketplace add williamrogersdev/eavesy && claude plugin install eavesy@eavesy --scope user';
/** Signs Claude Code in to the plugin's server. It opens the browser, so a person has to run it. */
export const CLAUDE_CODE_SIGN_IN = 'claude mcp login plugin:eavesy:eavesy';
/** Says whether that worked: "✔ Connected" or "! Needs authentication". */
const CLAUDE_CODE_CHECK = 'claude mcp get plugin:eavesy:eavesy';

/** For Claude Code itself to paste into: it runs the commands, and hands the browser sign-in back to you. */
export const CLAUDE_CODE_AGENT_PROMPT = [
  'Set up Eavesy for me in Claude Code. Eavesy is my library of meetings, dictations and notes, and it connects over MCP.',
  '',
  '1. Run: claude plugin marketplace add williamrogersdev/eavesy',
  '2. Run: claude plugin install eavesy@eavesy --scope user',
  '   If either says it is already added or installed, that is fine. Carry on.',
  `3. Run: ${CLAUDE_CODE_CHECK}`,
  '   It should list the server with Status: Needs authentication.',
  `4. Signing in needs my browser, so don't do it yourself. Tell me to run \`${CLAUDE_CODE_SIGN_IN}\` in a terminal and approve Claude Code in the browser window it opens.`,
  `5. When I say I've approved it, run \`${CLAUDE_CODE_CHECK}\` again and tell me whether it says Connected. The Eavesy tools appear after Claude Code restarts.`,
].join('\n');

/** For any other agent or MCP app to paste into. It sets the server up its own way; we don't guess its config file. */
export const MCP_AGENT_PROMPT = [
  'Add Eavesy to this app as a remote MCP server. Eavesy is my library of meetings, dictations and notes.',
  '',
  '- Name: eavesy',
  `- URL: ${MCP_URL}`,
  '- Transport: streamable HTTP',
  '- Sign-in: OAuth. There is no API key or token to set.',
  '',
  "Use this app's own way of adding MCP servers (its settings, its CLI, or its MCP config file). Then tell me how to start the sign-in: the app opens Eavesy in my browser and I approve it there.",
].join('\n');

/** An app approved by Claude Code, from the name it signed in with. */
export function isClaudeCodeToken(token: Pick<McpToken, 'name'>): boolean {
  return /claude[\s_-]*code/i.test(token.name);
}

/** An app the account approved (OAuth) or a token made by hand, as `/api/mcp-tokens` lists it. */
export interface McpToken {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt?: number | null;
  expiresAt: number | null;
  canWrite: boolean;
  usesLegacyUrl: boolean;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export function parseMcpTokens(value: unknown): McpToken[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): McpToken[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.createdAt !== 'number'
    ) {
      return [];
    }
    return [{
      id: item.id,
      name: item.name,
      createdAt: item.createdAt,
      lastUsedAt: nullableNumber(item.lastUsedAt),
      expiresAt: nullableNumber(item.expiresAt),
      canWrite: Array.isArray(item.scopes) && item.scopes.includes('write'),
      usesLegacyUrl: item.usesLegacyUrl === true,
    }];
  });
}
