import { describe, expect, it } from 'bun:test';
import { captionTail, liveView, trackLabel, type LiveCaption, type LiveLine } from './live-captions';

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
