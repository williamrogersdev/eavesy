import type { AssistantActivity, AssistantCard, AssistantMode, AssistantRuleChange, AssistantState, AssistantThread, AssistantVoice } from '@/lib/desktop/bridge';

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

/** A capture you attached to a question: what its chip says, and the words Eavesy reads. */
export interface AskCapture {
  id: string;
  /** "Voice note · 1:07 PM": the chip, and the line Eavesy sees above the words. */
  label: string;
  text: string;
}

/**
 * The most a message may hold, under assistant/thread.rs `TEXT_CHARS` (4,000 chars).
 * `.length` counts UTF-16 units, never fewer than chars, so staying under it is safe.
 */
export const ASK_LIMIT = 3_900;
/** How many captures one question can carry. */
export const ASK_CAPTURES = 3;
/**
 * Room kept for your question when captures go with it, so the chip's "trimmed"
 * (worked out before you type) holds for any question up to this long.
 */
export const ASK_QUESTION_ROOM = 600;
/** Where your question ends and the captures you attached begin. */
const ABOUT_HEAD = '\n\nCaptures I’m asking about:';

/** One capture's words with no blank lines, so a blank line only ever starts the next capture. */
function oneBlock(text: string): string {
  return text.trim().replace(/\n\s*\n+/g, '\n');
}

/**
 * What is sent when you ask with captures attached: your question, then each
 * capture's label and words. Words are cut to fit `limit`, shortest first, so a
 * short note keeps all its words beside a long meeting. `trimmed` lists the ids
 * of the captures that were cut. `fits` is false when the question itself
 * leaves no room for them: that message can't be sent.
 */
export function askMessage(question: string, captures: readonly AskCapture[], limit = ASK_LIMIT): { text: string; trimmed: string[]; fits: boolean } {
  const asked = question.trim();
  if (!captures.length) return { text: asked, trimmed: [], fits: asked.length <= limit };
  const heads = captures.map((capture) => `\n\n[${capture.label.replace(/[[\]\n]/g, ' ')}]\n`);
  const fixed = ABOUT_HEAD.length + heads.reduce((sum, head) => sum + head.length, 0);
  // Each capture needs at least its '…'.
  const fits = asked.length + fixed + captures.length <= limit;
  let room = Math.max(0, limit - fixed - Math.max(asked.length, Math.min(ASK_QUESTION_ROOM, limit - fixed)));
  const words = captures.map((capture) => oneBlock(capture.text));
  const kept: string[] = new Array<string>(captures.length).fill('');
  const trimmed: string[] = [];
  const order = words.map((_, i) => i).sort((a, b) => words[a].length - words[b].length);
  order.forEach((index, n) => {
    const share = Math.max(0, Math.floor(room / (order.length - n)));
    const full = words[index];
    if (full.length <= share) kept[index] = full;
    else {
      kept[index] = share > 1 ? `${full.slice(0, share - 1).trimEnd()}…` : '…';
      trimmed.push(captures[index].id);
    }
    room -= kept[index].length;
  });
  return { text: asked + ABOUT_HEAD + heads.map((head, i) => head + kept[i]).join(''), trimmed, fits };
}

/** One of your turns split back into what you asked and the labels of the captures you attached. */
export function splitAsk(text: string): { question: string; about: string[] } {
  const at = text.indexOf(ABOUT_HEAD);
  if (at < 0) return { question: text, about: [] };
  const about = text
    .slice(at + ABOUT_HEAD.length)
    .split('\n\n[')
    .slice(1)
    .map((block) => {
      const end = block.indexOf(']\n');
      return end < 0 ? block : block.slice(0, end);
    });
  return { question: text.slice(0, at), about };
}

/**
 * The line in the ask bar while you're looking at captures: what Eavesy said
 * last (or that it's still answering) and how many cards wait for your click.
 * Null when there's no conversation and nothing waiting.
 */
export function peekLine(thread: Pick<AssistantThread, 'busy' | 'turns'>, waiting: number): { text: string; waiting: number } | null {
  if (thread.busy) return { text: 'Eavesy is answering…', waiting };
  const last = [...thread.turns].reverse().find((turn) => turn.who === 'eavesy' && turn.text.trim());
  if (!last && waiting <= 0) return null;
  const line = last ? last.text.trim().split('\n')[0] : '';
  return { text: line || 'Waiting for your click', waiting: Math.max(0, waiting) };
}

/** "1 waiting" for the peek and the conversation's way back. Empty when nothing is. */
export function waitingLabel(count: number): string {
  return count > 0 ? `${count} waiting` : '';
}
