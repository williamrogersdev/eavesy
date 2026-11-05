import { describe, expect, test } from 'bun:test';
import { mergeShared, type StoredEvent } from './calendar';

const AT = Date.UTC(2026, 10, 5, 15);
const HOUR = 60 * 60 * 1000;

function stored(over: Partial<StoredEvent> & { id: string }): StoredEvent {
  return {
    providerEventId: `g_${over.id}`,
    title: 'Design review',
    startsAt: AT,
    endsAt: AT + HOUR,
    meetingUrl: null,
    platform: null,
    participants: [],
    recordChoice: null,
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

  test('matches by Google event id, or by title and time, when there is no link', () => {
    expect(mergeShared([stored({ id: 'a', providerEventId: 'same' }), stored({ id: 'b', providerEventId: 'same', title: 'Renamed' })])).toHaveLength(1);
    const merged = mergeShared([stored({ id: 'a' }), stored({ id: 'b', meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'meet' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'a', meetingUrl: 'https://meet.google.com/abc-defg-hij', platform: 'meet' });
  });

  test('the same link at another time is another meeting', () => {
    const link = 'https://meet.google.com/abc-defg-hij';
    expect(mergeShared([stored({ id: 'a', meetingUrl: link }), stored({ id: 'b', title: 'Weekly', meetingUrl: link, startsAt: AT + 24 * HOUR, endsAt: AT + 25 * HOUR })])).toHaveLength(2);
  });

  test('keeps the copy that was recorded, or that has a record choice', () => {
    expect(mergeShared([stored({ id: 'a', providerEventId: 'x' }), stored({ id: 'b', providerEventId: 'x', recordChoice: 'skip' })])[0]!.id).toBe('b');
    expect(mergeShared([stored({ id: 'a', providerEventId: 'x', recordChoice: 'record' }), stored({ id: 'b', providerEventId: 'x', recordedMeetingId: 'm1' })])[0]!.id).toBe('b');
  });
});
