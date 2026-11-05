import { describe, expect, test } from 'bun:test';
import { mergeShared, type StoredEvent } from './calendar';

const AT = Date.UTC(2026, 10, 5, 15);
const HOUR = 60 * 60 * 1000;

function stored(over: Partial<StoredEvent> & { id: string }): StoredEvent {
  return {
    connectionId: 'cal_a',
    providerEventId: `g_${over.id}`,
    title: 'Design review',
    startsAt: AT,
    endsAt: AT + HOUR,
    meetingUrl: null,
    platform: null,
    participants: [],
    description: null,
    recordChoice: null,
    captureMode: null,
    recordedMeetingId: null,
    ...over,
  };
}

describe('mergeShared', () => {
  test('keeps events that are different meetings', () => {
    const events = [stored({ id: 'a' }), stored({ id: 'b', title: 'Standup' }), stored({ id: 'c', startsAt: AT + HOUR, endsAt: AT + 2 * HOUR })];
    expect(mergeShared(events).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  test('one meeting on two accounts is listed once, by its call link', () => {
    const merged = mergeShared([
      stored({ id: 'work', title: 'Design review', meetingUrl: 'https://zoom.us/j/123?pwd=x', platform: 'zoom', participants: [{ email: 'Sam@work.com', name: null }] }),
      stored({ id: 'home', title: 'Design review (Sam)', meetingUrl: 'https://ZOOM.us/j/123', platform: 'zoom', participants: [{ email: 'sam@work.com', name: 'Sam' }, { email: 'dana@x.com', name: 'Dana' }] }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('work');
    expect(merged[0]!.participants).toEqual([{ email: 'sam@work.com', name: 'Sam' }, { email: 'dana@x.com', name: 'Dana' }]);
  });

  test('matches by Google event id, or by title, time and a shared attendee across calendars', () => {
    expect(mergeShared([stored({ id: 'a', providerEventId: 'same' }), stored({ id: 'b', connectionId: 'cal_b', providerEventId: 'same', title: 'Renamed' })])).toHaveLength(1);
    const sam = [{ email: 'sam@work.com', name: null }];
    const merged = mergeShared([stored({ id: 'a', participants: sam }), stored({ id: 'b', connectionId: 'cal_b', meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'meet', participants: sam })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'a', meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'meet' });
  });

  test('same title and time alone is not enough', () => {
    const sam = [{ email: 'sam@work.com', name: null }];
    // One calendar, no attendee in common, or no real title: all stay apart.
    expect(mergeShared([stored({ id: 'a', participants: sam }), stored({ id: 'b', participants: sam })])).toHaveLength(2);
    expect(mergeShared([stored({ id: 'a', title: 'Focus time' }), stored({ id: 'b', connectionId: 'cal_b', title: 'Focus time' })])).toHaveLength(2);
    expect(mergeShared([stored({ id: 'a', title: '(No title)', participants: sam }), stored({ id: 'b', connectionId: 'cal_b', title: '(No title)', participants: sam })])).toHaveLength(2);
  });

  test('the user’s own address is not a shared attendee', () => {
    const me = [{ email: 'Me@home.com', name: null }];
    const pair = [stored({ id: 'a', title: 'Standup', participants: me }), stored({ id: 'b', connectionId: 'cal_b', title: 'Standup', participants: me })];
    expect(mergeShared(pair, ['me@home.com'])).toHaveLength(2);
    expect(mergeShared(pair)).toHaveLength(1);
  });

  test('a copy on another calendar never pulls two of one calendar’s blocks together', () => {
    const sam = [{ email: 'sam@work.com', name: null }];
    const merged = mergeShared([
      stored({ id: 'a', title: 'Standup', participants: sam }),
      stored({ id: 'b', title: 'Standup', participants: sam }),
      stored({ id: 'c', connectionId: 'cal_b', title: 'Standup', participants: sam }),
    ]);
    expect(merged.map((e) => e.id)).toEqual(['a', 'b']);
  });

  test('a copy that matches two others by different keys joins them into one', () => {
    const link = 'https://meet.google.com/abc-defg-hij';
    const merged = mergeShared([
      stored({ id: 'a', providerEventId: 'x', title: 'One' }),
      stored({ id: 'b', connectionId: 'cal_b', providerEventId: 'y', title: 'Two', meetingUrl: link }),
      stored({ id: 'c', connectionId: 'cal_c', providerEventId: 'x', title: 'Three', meetingUrl: link }),
    ]);
    expect(merged.map((e) => e.id)).toEqual(['a']);
    expect(merged[0]!.meetingUrl).toBe(link);
  });

  test('the same link at another time is another meeting', () => {
    const link = 'https://meet.google.com/abc-defg-hij';
    expect(mergeShared([stored({ id: 'a', meetingUrl: link }), stored({ id: 'b', title: 'Weekly', meetingUrl: link, startsAt: AT + 24 * HOUR, endsAt: AT + 25 * HOUR })])).toHaveLength(2);
  });

  test('keeps the copy that was recorded, or that has a record choice', () => {
    expect(mergeShared([stored({ id: 'a', providerEventId: 'x' }), stored({ id: 'b', providerEventId: 'x', recordChoice: 'skip' })])[0]!.id).toBe('b');
    const recorded = mergeShared([stored({ id: 'a', providerEventId: 'x', recordChoice: 'skip' }), stored({ id: 'b', providerEventId: 'x', recordedMeetingId: 'm1' })])[0]!;
    expect(recorded).toMatchObject({ id: 'b', recordChoice: 'skip' });
  });

  test('when copies disagree, the kept copy’s choice and recording win', () => {
    const chosen = mergeShared([stored({ id: 'a', providerEventId: 'x', recordChoice: 'skip' }), stored({ id: 'b', providerEventId: 'x', recordChoice: 'record' })])[0]!;
    expect(chosen).toMatchObject({ id: 'a', recordChoice: 'skip' });
    const recorded = mergeShared([stored({ id: 'a', providerEventId: 'x', recordedMeetingId: 'm1' }), stored({ id: 'b', providerEventId: 'x', recordedMeetingId: 'm2' })])[0]!;
    expect(recorded).toMatchObject({ id: 'a', recordedMeetingId: 'm1' });
  });
});
