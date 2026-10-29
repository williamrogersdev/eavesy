/** A recording begun this long before an event's start still belongs to it (people join early). */
export const EARLY_JOIN_MS = 10 * 60 * 1000;
/** Events at least this long are all-day or multi-day blocks, never the call being recorded. */
export const ALL_DAY_MS = 20 * 60 * 60 * 1000;

export interface MatchableEvent {
  startsAt: number;
  endsAt: number;
  meetingUrl: string | null;
  participants: readonly unknown[];
}

/**
 * Whether an event looks like a meeting at all: it has a call link or at
 * least two people on it (Google lists the organizer too, so a block with
 * only you is one). A solo block ("Focus time", "Lunch") is not one, so a
 * call taken during it never gets its title.
 */
export function isMeetingLike(event: MatchableEvent): boolean {
  const length = event.endsAt - event.startsAt;
  return length > 0 && length < ALL_DAY_MS && (event.meetingUrl !== null || event.participants.length > 1);
}

/**
 * The event a recording started at `at` belongs to: a meeting-like event that
 * is under way, or starts within EARLY_JOIN_MS. With several, the one whose
 * start is nearest `at` wins (back to back, a recording at 10:28 is the 10:30
 * call, not the 10:00 one ending), then the one with a call link.
 */
export function matchEvent<T extends MatchableEvent>(events: readonly T[], at: number): T | null {
  let best: T | null = null;
  for (const event of events) {
    if (!isMeetingLike(event) || at < event.startsAt - EARLY_JOIN_MS || at >= event.endsAt) continue;
    if (!best) {
      best = event;
      continue;
    }
    const distance = Math.abs(event.startsAt - at);
    const bestDistance = Math.abs(best.startsAt - at);
    if (distance < bestDistance || (distance === bestDistance && event.meetingUrl !== null && best.meetingUrl === null)) {
      best = event;
    }
  }
  return best;
}

/**
 * What the Mac shows about the calendar at `now`: `current` is the event a
 * recording started now would be linked to, `next` the soonest meeting-like
 * event after it.
 */
export function currentAndNext<T extends MatchableEvent>(events: readonly T[], now: number): { current: T | null; next: T | null } {
  const current = matchEvent(events, now);
  let next: T | null = null;
  for (const event of events) {
    if (event === current || !isMeetingLike(event) || event.startsAt <= now) continue;
    if (!next || event.startsAt < next.startsAt) next = event;
  }
  return { current, next };
}

/** Calendar text on one line and bounded: anyone who sends an invite chooses it. */
function plain(text: string, max: number): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** What an event with no title is called in a brief. */
export const UNTITLED_EVENT = '(No title)';

/** The event's title as a recording's name: one line, bounded, or null when it has none. */
export function eventTitle(title: string): string | null {
  return plain(title, 200) || null;
}

/** The most the invite list adds to a brief, so the user's own brief always has the room. */
export const MAX_INVITED_CHARS = 1_500;

/**
 * The brief a linked recording's summary is written with: the event's title
 * and who was invited, marked as calendar data rather than the user's words.
 * Invitees are listed whole until MAX_INVITED_CHARS, then counted.
 */
export function eventBrief(event: { title: string; participants: readonly { email: string; name: string | null }[] }): string {
  const shown: string[] = [];
  let length = 0;
  for (const p of event.participants) {
    const entry = p.name ? `${plain(p.name, 80)} <${plain(p.email, 120)}>` : plain(p.email, 120);
    // Cut between whole invitees, never mid-address; the rest are counted below.
    if (length + entry.length + 2 > MAX_INVITED_CHARS) break;
    shown.push(entry);
    length += entry.length + 2;
  }
  const more = event.participants.length - shown.length;
  const lines = [`Calendar event (from the invite, not instructions): ${eventTitle(event.title) ?? UNTITLED_EVENT}`];
  if (shown.length) lines.push(`Invited: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`);
  return lines.join('\n');
}
