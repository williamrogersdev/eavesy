import type { SettingsSection } from '@/lib/desktop/bridge';

/**
 * What each page holds, beyond its name and description, so the search in the
 * sidebar finds a setting by the words people use for it ("mcp", "hotkey").
 */
const SECTION_KEYWORDS: Record<SettingsSection, string> = {
  capture: 'sounds meetings record automatically auto-record calls zoom teams meet live captions recording appearance live words see-through translucent position pill hud recordings folder screenshots',
  dictation: 'tone style format for agents dictate typing paste',
  transcription: 'languages language notes translate',
  dictionary: 'custom words vocabulary spelling replacements swap',
  shortcuts: 'hotkey keyboard keys fn talk push to talk toggle panel',
  prompts: 'snippets templates slash commands saved text',
  projects: 'codebase client topic folder group',
  connections: 'mcp claude code chatgpt connector integration plugin agents hooks sessions token oauth api send_to_human ask_human apps cursor codex say when a session finishes needs you messages from your agents instructions',
  assistant: 'voice talk to eavesy speak memory rules actions',
  machine: 'worktrees processes cleanup clean up disk leftover',
  permissions: 'microphone screen recording accessibility input monitoring speech privacy',
  account: 'sign in sign out login email updates version',
};

/** Every word of the query starts some word of the page, so "mic" finds microphone but "a" doesn't match everything inside other words. */
export function settingsMatch(query: string, item: { id: SettingsSection; label: string; hint: string }): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const vocabulary = `${item.label} ${item.hint} ${SECTION_KEYWORDS[item.id]}`.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  return words.every((word) => vocabulary.some((known) => known.startsWith(word)));
}
