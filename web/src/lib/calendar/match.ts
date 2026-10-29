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
 * Whether an event looks like a meeting at all: it has a call link or someone
 * invited. A solo block ("Focus time", "Lunch") is not one, so a call taken
 * during it never gets its title.
 */
export function isMeetingLike(event: MatchableEvent): boolean {
  const length = event.endsAt - event.startsAt;
  return length > 0 && length < ALL_DAY_MS && (event.meetingUrl !== null || event.participants.length > 0);
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

/** The brief a linked recording's summary is written with: the event's title and who was invited. */
export function eventBrief(event: { title: string; participants: readonly { email: string; name: string | null }[] }): string {
  const shown = event.participants.slice(0, 30).map((p) => (p.name ? `${p.name} <${p.email}>` : p.email));
  const more = event.participants.length - shown.length;
  const lines = [`Calendar event: ${event.title}`];
  if (shown.length) lines.push(`Invited: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`);
  return lines.join('\n');
}
