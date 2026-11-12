import { describe, expect, it } from 'bun:test';
import { keepEnd, MAX_CHAT_TRANSCRIPT, meetingChatContext, meetingClock } from './meeting-chat-context';

const START = Date.UTC(2026, 10, 12, 15, 0, 0);
const meeting = { title: 'Pricing call', startedAt: START, status: 'complete' };

describe('meetingClock', () => {
  it('counts minutes, then hours', () => {
    expect(meetingClock(0)).toBe('0:00');
    expect(meetingClock(245_000)).toBe('4:05');
    expect(meetingClock(3_727_000)).toBe('1:02:07');
  });
});

describe('meetingChatContext', () => {
  it('gives every transcript line its time and speaker, so "an hour ago" can be found', () => {
    const context = meetingChatContext({
      meeting: { ...meeting, speakerNamesJson: JSON.stringify({ them: 'Priya' }) },
      segments: [
        { startMs: 5_000, text: 'Eighteen a seat.', speakerId: 'them' },
        { startMs: 3_660_000, text: 'Let me check with finance.', speakerId: 'you' },
      ],
    });
    expect(context).toContain('[0:05] Priya: Eighteen a seat.');
    expect(context).toContain('[1:01:00] You: Let me check with finance.');
  });

  it('says a meeting is still going on, how far in it is, and what was just heard', () => {
    const context = meetingChatContext(
      { meeting: { ...meeting, status: 'recording' }, summary: { tldr: 'Pricing is agreed.' }, segments: [{ startMs: 0, text: 'Hello.', speakerId: null }] },
      { heard: 'Others: and one more thing', now: START + 65 * 60_000 },
    );
    expect(context).toContain('still going on. It is now 1:05:00 into the meeting');
    expect(context).toContain('Notes so far');
    expect(context.indexOf('and one more thing')).toBeGreaterThan(context.indexOf('[0:00] Hello.'));
  });

  it('says nothing about now for a finished meeting', () => {
    expect(meetingChatContext({ meeting, segments: [] }, { now: START + 1000 })).not.toContain('still going on');
  });

  it('keeps a long meeting whole, and the end of one that is too long', () => {
    const line = (i: number) => ({ startMs: i * 4_000, text: `Line number ${i} of the meeting, said at some length to fill it.`, speakerId: 'you' });
    const twoHours = Array.from({ length: 1_800 }, (_, i) => line(i));
    expect(meetingChatContext({ meeting, segments: twoHours })).toContain('[0:00] You: Line number 0 ');
    const tooLong = Array.from({ length: 9_000 }, (_, i) => line(i));
    const context = meetingChatContext({ meeting, segments: tooLong });
    expect(context.length).toBeLessThan(MAX_CHAT_TRANSCRIPT + 1_000);
    expect(context).toContain('Line number 8999 ');
    expect(context).not.toContain('Line number 0 ');
    // The cut falls on a line start.
    expect(context.split('each line starts with its time into the meeting):\n')[1]?.startsWith('[')).toBe(true);
  });

  it('takes what the Mac heard only for a meeting still going on, and says it is not the transcript', () => {
    const live = meetingChatContext({ meeting: { ...meeting, status: 'recording' }, segments: [] }, { heard: 'something about the budget' });
    expect(live).toContain('No transcript has been written yet.');
    expect(live).toContain('unchecked live captions, not the transcript');
    expect(live).toContain('something about the budget');
    expect(live).not.toContain('after the transcript above');
    // A finished meeting has its transcript: nothing a client adds is read as part of it.
    const done = meetingChatContext({ meeting, segments: [{ startMs: 0, text: 'Hello.', speakerId: null }] }, { heard: 'made-up words' });
    expect(done).not.toContain('made-up words');
  });
});

describe('keepEnd', () => {
  it('cuts one very long line where it falls, never through a character', () => {
    const long = 'x'.repeat(500) + '😀' + 'y'.repeat(9);
    // Ten units from the end is the emoji's second half: it is dropped whole.
    expect(keepEnd(long, 10)).toBe('y'.repeat(9));
    expect(keepEnd(long, 11)).toBe('😀' + 'y'.repeat(9));
    expect(keepEnd('short', 10)).toBe('short');
  });

  it('starts at a line start when one is near', () => {
    expect(keepEnd('[0:01] one\n[0:02] two\n[0:03] three', 22)).toBe('[0:03] three');
  });
});
