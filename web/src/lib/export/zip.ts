import JSZip from 'jszip';
import type { getFull } from '@/db/repo/meetings';
import { parseSpeakerNames } from '@/lib/transcription/two-track';
import {
  folderName,
  renderMeetingJson,
  renderNotesMd,
  renderSummaryMd,
  renderTranscriptMd,
  type MeetingForExport,
  type SummaryForExport,
  type TranscriptSegmentForExport,
} from './meeting-folder';

export interface ZipBundleInput {
  meeting: MeetingForExport;
  summary: SummaryForExport;
  segments: TranscriptSegmentForExport[];
  speakerNames?: Record<string, string>;
  chapters?: { startMs: number; title: string }[];
  notesMd: string;
  summaryOverrideMd?: string | null;
  transcriptOverrideMd?: string | null;
  audioOriginal?: { filename: string; data: Uint8Array; contentType: string };
  audioMp3?: { filename: string; data: Uint8Array };
}

export async function buildMeetingZip(input: ZipBundleInput): Promise<Uint8Array> {
  const zip = new JSZip();
  addMeetingFolder(zip, input);
  return await zip.generateAsync({ type: 'uint8array' });
}

export function addMeetingFolder(zip: JSZip, input: ZipBundleInput, parent = '') {
  const folder = zip.folder(`${parent}${folderName(input.meeting)}`);
  if (!folder) throw new Error('Failed to create zip folder');

  folder.file(
    'summary.md',
    input.summaryOverrideMd ?? renderSummaryMd(input.meeting, input.summary),
  );
  folder.file(
    'transcript.md',
    input.transcriptOverrideMd ?? renderTranscriptMd(input.meeting, input.segments, { speakerNames: input.speakerNames, chapters: input.chapters }),
  );
  folder.file('notes.md', renderNotesMd(input.meeting, input.notesMd));
  folder.file(
    'meeting.json',
    renderMeetingJson({
      meeting: input.meeting,
      summary: input.summary,
      segments: input.segments,
      notesMd: input.notesMd,
      summaryOverrideMd: input.summaryOverrideMd,
      transcriptOverrideMd: input.transcriptOverrideMd,
    }),
  );

  if (input.audioMp3) {
    folder.file('audio.mp3', input.audioMp3.data);
  }
  if (input.audioOriginal) {
    folder.file(input.audioOriginal.filename, input.audioOriginal.data);
  }
}

type FullMeeting = NonNullable<Awaited<ReturnType<typeof getFull>>>;

export function zipInputFor(
  { meeting, summary, segments, notes }: FullMeeting,
  audioOriginal?: ZipBundleInput['audioOriginal'],
): ZipBundleInput {
  return {
    meeting: {
      id: meeting.id,
      title: meeting.title,
      description: meeting.description,
      startedAt: meeting.startedAt,
      durationSec: meeting.durationSec ?? undefined,
      platform: meeting.platform ?? undefined,
      language: meeting.language,
      audioLocalFilename: audioOriginal?.filename,
    },
    summary: {
      tldr: summary?.tldr ?? '',
      decisions: summary?.decisions ?? [],
      actionItems: summary?.actionItems ?? [],
      followUps: summary?.followUps ?? [],
      openQuestions: summary?.openQuestions ?? [],
      topics: summary?.topics ?? [],
      mentions: summary?.mentions ?? [],
    },
    segments: segments.map((s) => ({
      startMs: s.startMs,
      speakerId: s.speakerId ?? undefined,
      text: s.text,
    })),
    speakerNames: parseSpeakerNames(meeting.speakerNamesJson),
    chapters: summary?.chapters ?? [],
    notesMd: notes?.contentMd ?? '',
    summaryOverrideMd: meeting.summaryOverrideMd,
    transcriptOverrideMd: meeting.transcriptOverrideMd,
    audioOriginal,
  };
}
