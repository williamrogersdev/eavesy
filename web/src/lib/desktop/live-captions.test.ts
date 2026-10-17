import { describe, expect, it } from 'bun:test';
import {
  addCaption,
  captionTail,
  EMPTY_RUNNING,
  liveView,
  runningText,
  trackLabel,
  type LiveCaption,
  type LiveLine,
} from './live-captions';

const line = (startMs: number, text: string, provisional = false): LiveLine => ({
  startMs,
  endMs: startMs + 1_000,
  track: 'mic',
  text,
  provisional,
});
const partial = (startMs: number, text: string, isFinal = false): LiveCaption => ({
  sessionId: 's',
  track: 'mic',
  text,
  isFinal,
  startMs,
  endMs: startMs + 500,
});

describe('captionTail', () => {
  it('keeps short captions whole', () => {
    expect(captionTail('  hello   there ')).toBe('hello there');
  });

  it('shows the latest words of a long caption, cut at a word', () => {
    const tail = captionTail('one two three four five six seven eight nine ten', 20);
    expect(tail.startsWith('…')).toBe(true);
    expect(tail.endsWith('nine ten')).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(21);
  });
});

describe('liveView', () => {
  it('shows the last stored lines, then what is still being heard', () => {
    const view = liveView([line(0, 'A.'), line(2_000, 'B.', true)], [partial(5_000, 'and then')]);
    expect(view).toEqual([
      { text: 'A.', provisional: false, label: 'You' },
      { text: 'B.', provisional: true, label: 'You' },
      { text: 'and then', provisional: true, label: 'You' },
    ]);
  });

  it('drops partials already stored and finals', () => {
    const view = liveView([line(5_000, 'Stored.')], [partial(4_000, 'old'), partial(7_000, 'final', true)]);
    expect(view).toEqual([{ text: 'Stored.', provisional: false, label: 'You' }]);
  });

  it('keeps only the most recent few', () => {
    const view = liveView([line(0, '1'), line(1_000, '2'), line(2_000, '3'), line(3_000, '4')], [], 2);
    expect(view.map((row) => row.text)).toEqual(['3', '4']);
  });
});

describe('trackLabel', () => {
  it('names the two tracks and nothing else', () => {
    expect(trackLabel('mic')).toBe('You');
    expect(trackLabel('system')).toBe('Others');
    expect(trackLabel('speaker_2')).toBeNull();
    expect(trackLabel(null)).toBeNull();
  });
});

describe('running transcript', () => {
  const add = (captions: LiveCaption[]) => captions.reduce(addCaption, EMPTY_RUNNING);

  it('keeps every settled line and the words still being heard', () => {
    const state = add([partial(0, 'hel'), partial(0, 'Hello there.', true), partial(1_500, 'and one')]);
    expect(runningText(state)).toBe('Hello there. and one');
  });

  it('a final replaces only its own track’s partial', () => {
    const them = { ...partial(500, 'they say'), track: 'system' };
    const state = add([them, partial(0, 'I said'), partial(0, 'I said.', true)]);
    expect(runningText(state)).toBe('I said. they say');
  });

  it('starts over for a new recording', () => {
    const state = add([partial(0, 'old words', true), { ...partial(0, 'new', true), sessionId: 't' }]);
    expect(runningText(state)).toBe('new');
    expect(state.sessionId).toBe('t');
  });
});
