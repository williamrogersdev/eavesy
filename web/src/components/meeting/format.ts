import { ANONYMOUS_TOKEN_STORAGE_KEY } from '@/lib/runtime';
import { hasBothSides, parseSpeakerNames, speakerName } from '@/lib/transcription/two-track';
import { clockLabel } from './transcript-player';
import { type MeetingData, type MeetingMeta } from './types';

export function audioUrl(meeting: MeetingMeta): string | null {
  if (!meeting.audioR2Key) return null;
  const token = typeof window !== 'undefined' ? window.localStorage.getItem(ANONYMOUS_TOKEN_STORAGE_KEY) : null;
  return `/api/audio/${meeting.audioR2Key}${token ? `?anonymousSessionToken=${encodeURIComponent(token)}` : ''}`;
}

export function buildContextMd(data: MeetingData): string {
  const { meeting, summary, segments, notes } = data;
  const out: string[] = [`# ${meeting.title}`, '', `_${new Date(meeting.startedAt).toLocaleString()}_`, ''];
  if (meeting.summaryOverrideMd?.trim()) {
    out.push(meeting.summaryOverrideMd.trim(), '');
  } else if (summary?.tldr) out.push('## TL;DR', summary.tldr, '');
  if (!meeting.summaryOverrideMd && summary?.decisions?.length) {
    out.push('## Decisions');
    summary.decisions.forEach((d) => out.push(`- ${d.text}`));
    out.push('');
  }
  if (!meeting.summaryOverrideMd && summary?.actionItems?.length) {
    out.push('## Action items');
    summary.actionItems.forEach((a) =>
      out.push(`- [${a.completed ? 'x' : ' '}] ${a.owner ? a.owner + ': ' : ''}${a.text}${a.due ? ` (due ${a.due})` : ''}`),
    );
    out.push('');
  }
  if (!meeting.summaryOverrideMd && summary?.openQuestions?.length) {
    out.push('## Open questions');
    summary.openQuestions.forEach((q) => out.push(`- ${q.text}`));
    out.push('');
  }
  if (notes?.contentMd?.trim()) out.push('## My notes', notes.contentMd.trim(), '');
  if (summary?.chapters?.length) {
    out.push('## Chapters');
    summary.chapters.forEach((c) => out.push(`- [${clockLabel(c.startMs)}] ${c.title}`));
    out.push('');
  }
  if (meeting.transcriptOverrideMd?.trim()) {
    out.push(meeting.transcriptOverrideMd.trim());
  } else if (segments?.length) {
    const labelled = hasBothSides(segments.map((s) => ({ speakerId: s.speakerId ?? null })));
    const names = parseSpeakerNames(meeting.speakerNamesJson);
    out.push('## Transcript');
    segments.forEach((s) => {
      const who = labelled && s.speakerId ? `${speakerName(s.speakerId, names)}: ` : '';
      out.push(`[${clockLabel(s.startMs)}] ${who}${s.text}`);
    });
  }
  return out.join('\n');
}

export function buildBriefMarkdown(data: MeetingData): string {
  if (data.meeting.summaryOverrideMd?.trim()) return data.meeting.summaryOverrideMd;
  const { meeting, summary } = data;
  const out = [`# ${meeting.title}`, ''];
  if (summary?.tldr) out.push('## TL;DR', summary.tldr, '');
  if (summary?.decisions.length) {
    out.push('## Decisions', ...summary.decisions.map((item) => `- ${item.text}`), '');
  }
  if (summary?.actionItems.length) {
    out.push(
      '## Action items',
      ...summary.actionItems.map(
        (item) => `- [${item.completed ? 'x' : ' '}] ${item.owner ? `${item.owner}: ` : ''}${item.text}${item.due ? ` (due ${item.due})` : ''}`,
      ),
      '',
    );
  }
  if (summary?.openQuestions.length) {
    out.push('## Open questions', ...summary.openQuestions.map((item) => `- ${item.text}`), '');
  }
  return out.join('\n').trimEnd();
}
