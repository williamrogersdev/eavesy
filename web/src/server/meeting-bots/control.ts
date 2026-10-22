/**
 * The meeting-bot Worker (workers/meeting-bot), as the web and processing
 * Workers see it through their `MEETING_BOTS` service binding. Each bot is a
 * Durable Object that owns one container running the Rust bot.
 */
export interface MeetingBotControl {
  /** Starts the bot at `joinAt` (epoch ms), or now when it is null or past. */
  schedule(botId: string, joinAt: number | null): Promise<void>;
  /** Asks a bot in a call to leave; what it recorded is still delivered. */
  leave(botId: string): Promise<boolean>;
  /** Stops the bot's container if it is running. */
  stop(botId: string): Promise<void>;
}

export interface MeetingBotsEnv {
  /** Absent where the meeting-bot Worker isn't deployed (tests, some self-hosts). */
  MEETING_BOTS?: MeetingBotControl;
}

/** One speaking span from the bot: [name, startMs, endMs] on the recording's clock. */
export type SpeakerSpan = [string, number, number];

export function parseSpeakerSpans(value: unknown): SpeakerSpan[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((s): s is SpeakerSpan => Array.isArray(s) && typeof s[0] === 'string' && Number.isFinite(s[1]) && Number.isFinite(s[2]))
    .map(([name, start, end]): SpeakerSpan => [name.trim().slice(0, 80), Math.max(0, start), Math.max(start, end)])
    .filter(([name]) => name.length > 0)
    .slice(0, 50_000);
}

/**
 * Names each transcript line after whoever the meeting app showed talking for
 * most of it, as `speaker_N` ids numbered by first appearance with the names
 * kept beside them for `meetings.speaker_names_json`. Lines nobody was shown
 * speaking during keep no speaker.
 */
export function attributeSpeakers(lines: { id: string; startMs: number; endMs: number }[], spans: SpeakerSpan[]) {
  const speakerOf = new Map<string, string>();
  const speakerNames: Record<string, string> = {};
  const assignments = new Map<string, string>();
  const sorted = [...spans].sort((a, b) => a[1] - b[1]);
  // One sweep: lines in start order take in the spans that have started and
  // drop the ones that ended before them, so each span is added and dropped once.
  let next = 0;
  let active: SpeakerSpan[] = [];
  for (const line of [...lines].sort((a, b) => a.startMs - b.startMs)) {
    const end = Math.max(line.endMs, line.startMs + 500);
    while (next < sorted.length && sorted[next][1] < end) active.push(sorted[next++]);
    active = active.filter(([, , stop]) => stop > line.startMs);
    const overlap = new Map<string, number>();
    for (const [name, start, stop] of active) {
      const shared = Math.min(stop, end) - Math.max(start, line.startMs);
      if (shared > 0) overlap.set(name, (overlap.get(name) ?? 0) + shared);
    }
    let best: string | null = null;
    let most = 0;
    for (const [name, ms] of overlap) {
      if (ms > most) {
        most = ms;
        best = name;
      }
    }
    if (!best) continue;
    let speakerId = speakerOf.get(best);
    if (!speakerId) {
      speakerId = `speaker_${speakerOf.size}`;
      speakerOf.set(best, speakerId);
      speakerNames[speakerId] = best;
    }
    assignments.set(line.id, speakerId);
  }
  return { assignments, speakerNames };
}
