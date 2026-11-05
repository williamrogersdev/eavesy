import type { MeetingAttendee, UpcomingMeeting } from '@/lib/api/calendar';

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "Today 3:30 PM", "Tomorrow 9:00 AM", or "Now, until 4:00 PM" once it has started. */
export function meetingTime(meeting: Pick<UpcomingMeeting, 'startsAt' | 'endsAt'>, now: number): string {
  if (meeting.startsAt <= now) return `Now, until ${clock(meeting.endsAt)}`;
  const day = new Date(meeting.startsAt).toDateString() === new Date(now).toDateString() ? 'Today' : 'Tomorrow';
  return `${day} ${clock(meeting.startsAt)}`;
}

/** "Today 3:30 PM – 4:00 PM". */
export function meetingSpan(meeting: Pick<UpcomingMeeting, 'startsAt' | 'endsAt'>, now: number): string {
  const day = new Date(meeting.startsAt).toDateString() === new Date(now).toDateString() ? 'Today' : 'Tomorrow';
  return `${day} ${clock(meeting.startsAt)} – ${clock(meeting.endsAt)}`;
}

/** Whether Eavesy records this meeting when its call starts. */
export function recordsMeeting(meeting: Pick<UpcomingMeeting, 'recordChoice'>, autoRecord: boolean): boolean {
  return meeting.recordChoice === null ? autoRecord : meeting.recordChoice === 'record';
}

/** The choice to store for a switch flipped to `record`: none when that is what the setting says anyway. */
export function choiceFor(record: boolean, autoRecord: boolean): UpcomingMeeting['recordChoice'] {
  return record === autoRecord ? null : record ? 'record' : 'skip';
}

/** What the record switch's hint says. Recording always happens here, on this Mac. */
export function recordHint(meeting: Pick<UpcomingMeeting, 'recordChoice'>, autoRecord: boolean): string {
  if (recordsMeeting(meeting, autoRecord)) return 'Eavesy records it on this Mac when the call starts.';
  return meeting.recordChoice === 'skip' ? 'Eavesy leaves this one alone.' : 'Eavesy asks when the call starts.';
}

/** Up to `max` people by name (or email), and how many more there are. */
export function attendeeList(attendees: MeetingAttendee[], max: number): { names: string[]; more: number } {
  const names = attendees.map((person) => person.name ?? person.email);
  return { names: names.slice(0, max), more: Math.max(0, names.length - max) };
}

/** The join link's host, to say where it goes: "meet.google.com". */
export function linkHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.host : null;
  } catch {
    return null;
  }
}
