import { parseSpeakerNames, speakerName } from '@/lib/transcription/two-track';

/** What the meeting chat is told about one meeting. */
export interface MeetingChatSource {
  meeting: {
    title: string;
    startedAt: number;
    status: string;
    contextBlurb?: string | null;
    summaryOverrideMd?: string | null;
    transcriptOverrideMd?: string | null;
    speakerNamesJson?: string | null;
  };
  summary?: {
    tldr?: string | null;
    decisions?: { text: string }[] | null;
    actionItems?: { owner?: string | null; text: string; due?: string | null }[] | null;
    openQuestions?: { text: string }[] | null;
  } | null;
  notes?: { contentMd?: string | null } | null;
  segments?: { startMs: number; text: string; speakerId: string | null }[] | null;
}

/**
 * How much transcript the chat reads, in characters: about six hours of
 * talk. A longer one keeps its end, the part a question during the call is
 * most often about.
 */
export const MAX_CHAT_TRANSCRIPT = 400_000;
/** How much the Mac may add of what it has heard and the cloud hasn't written yet. */
export const MAX_HEARD = 12_000;

/** "4:05" into the meeting, "1:02:07" past the hour: what "an hour ago" is counted from. */
export function meetingClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function keepEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  // From a line start, so a cut never leaves half a line without its time.
  const tail = text.slice(-max);
  const line = tail.indexOf('\n');
  return line >= 0 && line < 400 ? tail.slice(line + 1) : tail;
}

/**
 * The context for a chat about one meeting, finished or still going on.
 * `heard` is what the recorder's Mac has heard since the last transcript
 * line; `now` is the time of asking.
 */
export function meetingChatContext(data: MeetingChatSource, opts: { heard?: string; now?: number } = {}): string {
  const { meeting, summary, segments, notes } = data;
  const live = meeting.status === 'recording' || meeting.status === 'uploading';
  const out: string[] = [`Title: ${meeting.title}`, `Started: ${new Date(meeting.startedAt).toISOString()}`];
  if (live && opts.now) {
    out.push(`Status: still going on. It is now ${meetingClock(opts.now - meeting.startedAt)} into the meeting.`);
  }

  if (meeting.contextBlurb?.trim()) {
    out.push('', 'User-supplied meeting context (ground truth; substitutes for absent speaker labels):', meeting.contextBlurb.trim());
  }

  if (meeting.summaryOverrideMd?.trim()) {
    out.push('', 'User-edited brief:', meeting.summaryOverrideMd.trim());
  } else if (summary) {
    if (live) out.push('', 'Notes so far (written a few minutes behind the transcript):');
    if (summary.tldr) out.push('', `TL;DR: ${summary.tldr}`);
    if (summary.decisions?.length) out.push('', 'Decisions:', ...summary.decisions.map((d) => `- ${d.text}`));
    if (summary.actionItems?.length) {
      out.push('', 'Action items:', ...summary.actionItems.map((a) => `- ${a.owner ? a.owner + ': ' : ''}${a.text}${a.due ? ` (due ${a.due})` : ''}`));
    }
    if (summary.openQuestions?.length) out.push('', 'Open questions:', ...summary.openQuestions.map((q) => `- ${q.text}`));
  }

  if (notes?.contentMd?.trim()) out.push('', 'User notes:', notes.contentMd.trim());

  if (meeting.transcriptOverrideMd?.trim()) {
    out.push('', 'User-edited transcript:', keepEnd(meeting.transcriptOverrideMd.trim(), MAX_CHAT_TRANSCRIPT));
  } else if (segments?.length) {
    const names = parseSpeakerNames(meeting.speakerNamesJson);
    const transcript = segments
      .map((s) => `[${meetingClock(s.startMs)}] ${s.speakerId ? speakerName(s.speakerId, names) + ': ' : ''}${s.text}`)
      .join('\n');
    out.push('', 'Transcript (each line starts with its time into the meeting):', keepEnd(transcript, MAX_CHAT_TRANSCRIPT));
  }

  const heard = opts.heard?.trim();
  if (heard) {
    out.push('', 'Heard in the last moments, after the transcript above (rough, may repeat its last lines):', keepEnd(heard, MAX_HEARD));
  }

  return out.join('\n');
}
