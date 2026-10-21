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

  it('keeps a final visible until its stored row arrives', () => {
    const view = liveView([line(5_000, 'Stored.')], [partial(4_000, 'old'), partial(7_000, 'final', true)]);
    expect(view).toEqual([{ text: 'Stored.', provisional: false, label: 'You' }, { text: 'final', provisional: true, label: 'You' }]);
  });

  it('does not hide mic captions when computer audio is further ahead', () => {
    const system = { ...line(10_000, 'Other speaker.'), track: 'system' };
    expect(liveView([system], [partial(5_000, 'My words')]).map((row) => row.text)).toEqual(['Other speaker.', 'My words']);
  });

  it('replaces the live final with its persisted row without duplicating it', () => {
    expect(liveView([line(7_000, 'Final.')], [partial(7_000, 'Final.', true)])).toEqual([{ text: 'Final.', provisional: false, label: 'You' }]);
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

describe('phrases awaiting finals', () => {
  it('keeps the beginning and middle when only the last phrase is still arriving', () => {
    let state = addCaption(EMPTY_RUNNING, partial(0, 'Start.'));
    state = addCaption(state, partial(2_000, 'Middle.'));
    state = addCaption(state, partial(4_000, 'Trailing end.'));
    expect(runningText(state)).toBe('Start. Middle. Trailing end.');
    state = addCaption(state, partial(0, 'Start.', true));
    state = addCaption(state, partial(2_000, 'Middle.', true));
    expect(runningText(state)).toBe('Start. Middle. Trailing end.');
    state = addCaption(state, partial(4_000, 'Trailing end.', true));
    expect(runningText(state)).toBe('Start. Middle. Trailing end.');
  });
});


it('slightly overlapping recognition windows preserve both settled phrases', () => {
  let state = addCaption(EMPTY_RUNNING, { sessionId: 'overlap', track: 'mic', text: 'First sentence.', isFinal: true, startMs: 0, endMs: 1000 });
  state = addCaption(state, { sessionId: 'overlap', track: 'mic', text: 'Next sentence.', isFinal: true, startMs: 900, endMs: 2000 });
  expect(runningText(state)).toBe('First sentence. Next sentence.');
  state = addCaption(state, { sessionId: 'overlap', track: 'mic', text: 'Corrected first sentence.', isFinal: true, startMs: 0, endMs: 1000 });
  expect(runningText(state)).toBe('Corrected first sentence. Next sentence.');
});

it('heavily overlapping windows keep substantially different final text', () => {
  let state = addCaption(EMPTY_RUNNING, { sessionId: 'heavy', track: 'mic', text: 'Please bring the red notebook.', isFinal: true, startMs: 0, endMs: 2000 });
  state = addCaption(state, { sessionId: 'heavy', track: 'mic', text: 'Then close the kitchen window.', isFinal: true, startMs: 500, endMs: 2500 });
  expect(runningText(state)).toBe('Please bring the red notebook. Then close the kitchen window.');
});

it('does not discard a contained final spoken at a different start', () => {
  let state = addCaption(EMPTY_RUNNING, { sessionId: 'contained', track: 'mic', text: 'Okay.', isFinal: true, startMs: 0, endMs: 2000 });
  state = addCaption(state, { sessionId: 'contained', track: 'mic', text: 'Okay. Then close the window.', isFinal: true, startMs: 500, endMs: 2500 });
  expect(runningText(state)).toBe('Okay. Okay. Then close the window.');
});

it('deduplicates settled sentence timestamp jitter but preserves later repetition', () => {
  let state = addCaption(EMPTY_RUNNING, { sessionId: 'jitter', track: 'mic', text: 'The blue Notebook is on the kitchen table.', isFinal: true, startMs: 1000, endMs: 4000 });
  state = addCaption(state, { sessionId: 'jitter', track: 'mic', text: 'The blue notebook is on the kitchen table.', isFinal: true, startMs: 1040, endMs: 4020 });
  expect(runningText(state)).toBe('The blue notebook is on the kitchen table.');
  state = addCaption(state, { sessionId: 'jitter', track: 'mic', text: 'The blue notebook is on the kitchen table.', isFinal: true, startMs: 5000, endMs: 8000 });
  expect(runningText(state)).toBe('The blue notebook is on the kitchen table. The blue notebook is on the kitchen table.');
});

it('replaces a volatile sentence whose range includes the silent lead-in', () => {
  const volatile = {...partial(0, 'The blue Notebook is on the kitchen table.'), endMs:23159};
  const settled = {...partial(18060, 'The blue notebook is on the kitchen table.', true), endMs:21240};
  let state = addCaption(EMPTY_RUNNING, volatile);
  state = addCaption(state, settled);
  state = addCaption(state, volatile);
  expect(runningText(state)).toBe(settled.text);
});
