import type { AssistantCard, AssistantMode, AssistantState } from '@/lib/desktop/bridge';

/** Friendly names for the tools in a turn's steps. Unknown tools show their own name. */
const TOOL_LABELS: Record<string, string> = {
  machine_overview: 'Looked at this Mac',
  agent_sessions: 'Checked your agent sessions',
  open_link: 'Opened a link',
  clean_machine: 'Clean-up',
};

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

/** What the mode chip says: the mode in force, with the time left when it's timed. */
export function modeLabel(state: Pick<AssistantState, 'effective' | 'until_ms'>, now: number): string {
  const name = { ask: 'Ask', auto: 'Auto', bypass: 'Bypass' }[state.effective];
  if (state.effective === 'ask' || state.until_ms === null) return name;
  const minutes = Math.max(1, Math.ceil((state.until_ms - now) / 60_000));
  return minutes >= 60 ? `${name} · ${Math.round(minutes / 60)}h` : `${name} · ${minutes}m`;
}

/** Anything but Ask is shown in warn ink, so you always know clicks are being skipped. */
export function modeIsLoud(mode: AssistantMode): boolean {
  return mode !== 'ask';
}

/** Every row starts ticked; the button names how many will go. */
export function acceptLabel(card: AssistantCard, ticked: ReadonlySet<string>): string {
  const count = card.rows.filter((row) => ticked.has(row.id)).length;
  if (card.rows.length <= 1) return 'Allow';
  return count === card.rows.length ? `Allow these ${count}` : `Allow ${count} of ${card.rows.length}`;
}

/** Seconds left on a card, for "expires in" once it's close. */
export function secondsLeft(card: AssistantCard, now: number): number {
  return Math.max(0, Math.round((card.expires_ms - now) / 1000));
}
