import type { AssistantActivity, AssistantCard, AssistantMode, AssistantRuleChange, AssistantState, AssistantVoice } from '@/lib/desktop/bridge';

/** Friendly names for the tools in a turn's steps. Unknown tools show their own name. */
const TOOL_LABELS: Record<string, string> = {
  machine_overview: 'Looked at this Mac',
  agent_sessions: 'Checked your agent sessions',
  security_status: 'Checked security settings',
  security_fix: 'Security fix',
  open_link: 'Opened a link',
  clean_machine: 'Clean-up',
  remember: 'Memory',
  suggest_rule: 'Suggested a rule',
  // The names the action core logs to Activity.
  'machine.overview': 'Looked at this Mac',
  'agents.sessions': 'Checked your agent sessions',
  'security.status': 'Checked security settings',
  'security.fix': 'Security fix',
  'security.open_settings': 'Opened System Settings',
  'open.link': 'Opened a link',
  'machine.clean': 'Clean-up',
  'assistant.mode': 'Mode change',
  'assistant.trust': 'Trusted folders',
  'assistant.remember': 'Remembered',
  'assistant.forget': 'Forgot',
  'assistant.rule': 'Rules',
  'assistant.suggest_rule': 'Suggested a rule',
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

/** Voices in your language first, then the rest, each by name. */
export function sortVoices(voices: readonly AssistantVoice[], language: string): AssistantVoice[] {
  const mine = language.split(/[-_]/)[0].toLowerCase();
  const rank = (voice: AssistantVoice) => (voice.locale.split('_')[0].toLowerCase() === mine ? 0 : 1);
  return [...voices].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** One line of the Activity list: what happened, by whom, and how it ended. */
export function activityLine(entry: AssistantActivity): string {
  const decision = { ran: 'Ran', accepted: 'Accepted', declined: 'Declined', refused: 'Refused', card: 'Asked first' }[entry.decision] ?? entry.decision;
  return entry.outcome ? `${decision}: ${entry.outcome}` : decision;
}

/** One line for a change waiting in the rules review list. */
export function ruleChangeLine(change: AssistantRuleChange): string {
  switch (change.kind) {
    case 'add': return `Added: ${change.text}`;
    case 'remove': return `Removed: ${change.text}`;
    case 'add_instruction': return `New instruction: ${change.text}`;
    case 'remove_instruction': return `Instruction removed: ${change.text}`;
    case 'invalid': return `Line ${change.line}: ${change.text}`;
    case 'unreadable': return 'Eavesy can’t read rules.md';
  }
}

/** The thread's line when rule changes wait for you (H4). Null when none do. */
export function rulesWaitingLine(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? 'A rule change is waiting for you' : `${count} rule changes are waiting for you`;
}
