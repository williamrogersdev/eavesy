import type { ClaudeCodeStatus } from '@/lib/desktop/bridge';
import { isClaudeCodeToken, type McpToken } from '@/lib/mcp-tokens';

/**
 * Where Claude Code is with Eavesy:
 * - `web`: not in the Mac app, so Eavesy can't ask Claude Code; only the steps are shown.
 * - `checking`: in the app, before the first answer.
 * - `no-cli`: the app can't find `claude` on this Mac.
 * - `not-added` → `needs-sign-in` → `connected`.
 */
export type ClaudeCodeStage = 'web' | 'checking' | 'no-cli' | 'not-added' | 'needs-sign-in' | 'connected';

function live(token: McpToken, now: number): boolean {
  return isClaudeCodeToken(token) && (token.expiresAt === null || token.expiresAt > now);
}

export function claudeCodeStage(
  desktop: boolean,
  status: ClaudeCodeStatus | null,
  tokens: McpToken[] | null,
  now = Date.now(),
): ClaudeCodeStage {
  if (!desktop) return 'web';
  if (!status) return 'checking';
  if (!status.cli) return 'no-cli';
  if (!status.plugin && !status.server) return 'not-added';
  if (status.signIn === 'connected') return 'connected';
  // Claude Code couldn't say (offline, or an older `claude`): a live Claude Code
  // sign-in on the account is the next best sign this Mac finished.
  if (status.signIn !== 'needsSignIn' && tokens?.some((token) => live(token, now))) return 'connected';
  return 'needs-sign-in';
}

/**
 * Whether Claude Code belongs under "Connected AI apps" and not under "Add an
 * AI app". In the app that's what Claude Code on this Mac says; on the web,
 * where it can't be asked, a live Claude Code sign-in on the account.
 */
export function claudeCodeConnected(stage: ClaudeCodeStage, tokens: McpToken[] | null, now = Date.now()): boolean {
  if (stage === 'connected') return true;
  if (stage !== 'web') return false;
  return !!tokens?.some((token) => live(token, now));
}
