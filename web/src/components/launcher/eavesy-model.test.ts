import { describe, expect, test } from 'bun:test';
import type { AssistantCard } from '@/lib/desktop/bridge';
import { ASK_LIMIT, ASK_QUESTION_ROOM, acceptLabel, activityLine, askMessage, modeIsLoud, modeLabel, peekLine, ruleChangeLine, rulesWaitingLine, secondsLeft, sortVoices, splitAsk, toolLabel, waitingLabel } from './eavesy-model';

const card = (rows: string[]): AssistantCard => ({
  id: 'c', requester: 'You', tool: 'machine.clean', title: 'Remove 2 worktrees', warning: null, expires_ms: 60_000,
  rows: rows.map((id) => ({ id, label: id })),
});

describe('eavesy model', () => {
  test('the mode chip says what is in force and for how long', () => {
    expect(modeLabel({ effective: 'ask', until_ms: 5 }, 0)).toBe('Ask');
    expect(modeLabel({ effective: 'bypass', until_ms: null }, 0)).toBe('Bypass');
    expect(modeLabel({ effective: 'bypass', until_ms: 42 * 60_000 }, 0)).toBe('Bypass · 42m');
    expect(modeLabel({ effective: 'auto', until_ms: 3 * 3_600_000 }, 0)).toBe('Auto · 3h');
    expect(modeLabel({ effective: 'bypass', until_ms: 10 }, 0)).toBe('Bypass · 1m');
    expect(modeIsLoud('ask')).toBe(false);
    expect(modeIsLoud('bypass')).toBe(true);
  });

  test('the allow button counts the ticked rows', () => {
    const two = card(['a', 'b']);
    expect(acceptLabel(two, new Set(['a', 'b']))).toBe('Allow these 2');
    expect(acceptLabel(two, new Set(['b']))).toBe('Allow 1 of 2');
    expect(acceptLabel(card(['a']), new Set(['a']))).toBe('Allow');
    expect(secondsLeft(two, 59_000)).toBe(1);
    expect(secondsLeft(two, 70_000)).toBe(0);
  });

  test('tools get plain names', () => {
    expect(toolLabel('machine_overview')).toBe('Looked at this Mac');
    expect(toolLabel('something_new')).toBe('something_new');
  });
});

describe('assistant settings', () => {
  test('voices in your language come first', () => {
    const voices = [{ name: 'Thomas', locale: 'fr_FR' }, { name: 'Samantha', locale: 'en_US' }, { name: 'Daniel', locale: 'en_GB' }];
    expect(sortVoices(voices, 'en-AU').map((voice) => voice.name)).toEqual(['Daniel', 'Samantha', 'Thomas']);
    expect(sortVoices(voices, 'fr').map((voice) => voice.name)).toEqual(['Thomas', 'Daniel', 'Samantha']);
  });

  test('activity says how each action ended', () => {
    const base = { at_ms: 0, requester: 'You', tool: 'machine.clean', summary: 'Clean up 2' };
    expect(toolLabel(base.tool)).toBe('Clean-up');
    expect(activityLine({ ...base, decision: 'accepted', outcome: 'removed 2' })).toBe('Accepted: removed 2');
    expect(activityLine({ ...base, decision: 'card' })).toBe('Asked first');
    expect(activityLine({ ...base, decision: 'something new' })).toBe('something new');
  });

  test('rule changes read as one line each, and the thread says when any wait', () => {
    const rule = { kind: 'remove_worktrees' as const, under: '/Users/w/Developer' };
    expect(ruleChangeLine({ kind: 'add', rule, text: 'Remove finished worktrees under ~/Developer' })).toBe('Added: Remove finished worktrees under ~/Developer');
    expect(ruleChangeLine({ kind: 'remove', rule, text: 'X' })).toBe('Removed: X');
    expect(ruleChangeLine({ kind: 'invalid', line: 9, text: 'Delete it all', reason: 'no' })).toBe('Line 9: Delete it all');
    expect(rulesWaitingLine(0)).toBeNull();
    expect(rulesWaitingLine(1)).toBe('A rule change is waiting for you');
    expect(rulesWaitingLine(3)).toBe('3 rule changes are waiting for you');
  });
});

describe('asking about captures', () => {
  const note = { id: 'n', label: 'Note · 9:41 AM', text: 'Send Priya the deck.' };
  const meeting = { id: 'm', label: 'Meeting · Yesterday 3:10 PM', text: 'We agreed it ships first.\n\n\nSam checks drag and drop.' };

  test('a question alone is sent as typed', () => {
    expect(askMessage('  what did I promise?  ', [])).toEqual({ text: 'what did I promise?', trimmed: [], fits: true });
  });

  test('attached captures follow the question with their labels and words, and split back for the thread', () => {
    const { text, trimmed } = askMessage('What do I owe people?', [note, meeting]);
    expect(trimmed).toEqual([]);
    expect(text).toContain('[Note · 9:41 AM]\nSend Priya the deck.');
    // A capture's blank lines are closed up, so a blank line only ever starts the next capture.
    expect(text).toContain('[Meeting · Yesterday 3:10 PM]\nWe agreed it ships first.\nSam checks drag and drop.');
    expect(splitAsk(text)).toEqual({ question: 'What do I owe people?', about: ['Note · 9:41 AM', 'Meeting · Yesterday 3:10 PM'] });
    expect(splitAsk('Just a question')).toEqual({ question: 'Just a question', about: [] });
  });

  test('long words are cut to fit one message, shortest kept whole', () => {
    const long = { id: 'l', label: 'Meeting · 10:00 AM', text: 'word '.repeat(2_000) };
    const { text, trimmed } = askMessage('Summarize', [long, note]);
    expect(text.length).toBeLessThanOrEqual(ASK_LIMIT);
    expect(trimmed).toEqual(['l']);
    expect(text).toContain('Send Priya the deck.');
    expect(text).toContain('word…\n\n[Note · 9:41 AM]');
    expect(splitAsk(text).about).toEqual(['Meeting · 10:00 AM', 'Note · 9:41 AM']);
    // Whatever the mix, the message stays under the limit.
    const many = askMessage('q'.repeat(500), [long, long, long].map((c, i) => ({ ...c, id: `${i}` })));
    expect(many.text.length).toBeLessThanOrEqual(ASK_LIMIT);
    expect(many.trimmed).toHaveLength(3);
  });

  test('what the chip says is trimmed holds for any question up to the room kept for it', () => {
    const tight = { id: 't', label: 'Note · 9:41 AM', text: 'x'.repeat(ASK_LIMIT - 400) };
    const before = askMessage('', [tight]).trimmed;
    expect(askMessage('q'.repeat(ASK_QUESTION_ROOM), [tight]).trimmed).toEqual(before);
    expect(askMessage('q'.repeat(ASK_QUESTION_ROOM), [tight]).text.length).toBeLessThanOrEqual(ASK_LIMIT);
  });

  test('a question too long to carry its captures does not fit, and is never sent cut', () => {
    const huge = askMessage('q'.repeat(ASK_LIMIT), [note, meeting]);
    expect(huge.fits).toBe(false);
    expect(huge.text.startsWith('q'.repeat(ASK_LIMIT))).toBe(true);
    expect(askMessage('q'.repeat(ASK_LIMIT + 1), []).fits).toBe(false);
    const nearly = askMessage('q'.repeat(3_500), [note, meeting]);
    expect(nearly.fits).toBe(true);
    expect(nearly.text.length).toBeLessThanOrEqual(ASK_LIMIT);
  });

  test('the peek shows the last thing Eavesy said and what waits', () => {
    const turn = (who: 'you' | 'eavesy', text: string) => ({ id: 1, who, spoken: false, at_ms: 0, text, steps: [] });
    expect(peekLine({ busy: false, turns: [] }, 0)).toBeNull();
    expect(peekLine({ busy: false, turns: [] }, 2)).toEqual({ text: 'Waiting for your click', waiting: 2 });
    expect(peekLine({ busy: true, turns: [] }, 0)).toEqual({ text: 'Eavesy is answering…', waiting: 0 });
    expect(peekLine({ busy: false, turns: [turn('eavesy', 'Two left.\nMore here'), turn('you', 'ok')] }, 1)).toEqual({ text: 'Two left.', waiting: 1 });
    expect(waitingLabel(0)).toBe('');
    expect(waitingLabel(3)).toBe('3 waiting');
  });
});
