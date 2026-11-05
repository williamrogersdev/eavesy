import { describe, expect, test } from 'bun:test';
import { parseUpcomingMeeting } from '@/lib/api/calendar';
import { attendeeList, choiceFor, linkHost, meetingTime, recordHint, recordsMeeting } from './meeting-model';

describe('meeting model', () => {
  test('the switch follows the setting unless the meeting has its own choice', () => {
    expect(recordsMeeting({ recordChoice: null }, true)).toBe(true);
    expect(recordsMeeting({ recordChoice: null }, false)).toBe(false);
    expect(recordsMeeting({ recordChoice: 'skip' }, true)).toBe(false);
    expect(recordsMeeting({ recordChoice: 'record' }, false)).toBe(true);
    expect(choiceFor(true, true)).toBeNull();
    expect(choiceFor(false, true)).toBe('skip');
    expect(choiceFor(true, false)).toBe('record');
  });

  test('the hint never promises anything but recording on this Mac', () => {
    expect(recordHint({ recordChoice: null }, true)).toContain('on this Mac');
    expect(recordHint({ recordChoice: 'skip' }, true)).toBe('Eavesy leaves this one alone.');
    expect(recordHint({ recordChoice: null }, false)).toBe('Eavesy asks when the call starts.');
    for (const hint of [recordHint({ recordChoice: null }, true), recordHint({ recordChoice: 'record' }, false)]) {
      expect(hint.toLowerCase()).not.toContain('bot');
      expect(hint.toLowerCase()).not.toContain('join');
    }
  });

  test('a started meeting says until when', () => {
    const now = new Date(2026, 10, 5, 15, 0).getTime();
    expect(meetingTime({ startsAt: now - 60_000, endsAt: now + 30 * 60_000 }, now)).toStartWith('Now, until');
    expect(meetingTime({ startsAt: now + 60 * 60_000, endsAt: now + 90 * 60_000 }, now)).toStartWith('Today');
  });

  test('people are listed by name, then email, with a count of the rest', () => {
    const people = [{ email: 'ben@numeral.com', name: 'Ben' }, { email: 'w@eavesy.com', name: null }, { email: 'c@x.com', name: 'C' }];
    expect(attendeeList(people, 2)).toEqual({ names: ['Ben', 'w@eavesy.com'], more: 1 });
    expect(attendeeList([], 2)).toEqual({ names: [], more: 0 });
  });

  test('only https links are shown as somewhere to join', () => {
    expect(linkHost('https://meet.google.com/abc-defg-hij')).toBe('meet.google.com');
    expect(linkHost('javascript:alert(1)')).toBeNull();
    expect(linkHost('not a url')).toBeNull();
  });

  test('the menu bar meeting parses with its attendees', () => {
    const meeting = parseUpcomingMeeting({
      id: 'e1', title: 'Numeral Intro', startsAt: 1, endsAt: 2, meetingUrl: 'https://meet.google.com/x', recordChoice: 'skip',
      attendees: [{ email: 'ben@numeral.com', name: 'Ben' }, { email: 'x@y.com', name: ' ' }, { name: 'no email' }],
    });
    expect(meeting?.attendees).toEqual([{ email: 'ben@numeral.com', name: 'Ben' }, { email: 'x@y.com', name: null }]);
    expect(meeting?.recordChoice).toBe('skip');
    expect(parseUpcomingMeeting({ id: 'e1' })).toBeNull();
  });
});
