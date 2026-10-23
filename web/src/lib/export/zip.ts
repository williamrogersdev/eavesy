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
  /** `data` is omitted when the caller streams the audio itself. */
  audioOriginal?: { filename: string; data?: Uint8Array; contentType: string };
  audioMp3?: { filename: string; data: Uint8Array };
}

export function addMeetingFolder(zip: JSZip, input: ZipBundleInput, parent = '') {
  for (const file of meetingFolderFiles(input, parent)) zip.file(file.name, file.content);
}

/** The files of one meeting's export folder, named with their full path. */
export function meetingFolderFiles(
  input: ZipBundleInput,
  parent = '',
): { name: string; content: string | Uint8Array }[] {
  const folder = `${parent}${folderName(input.meeting)}`;
  const files: { name: string; content: string | Uint8Array }[] = [
    { name: `${folder}/summary.md`, content: input.summaryOverrideMd ?? renderSummaryMd(input.meeting, input.summary) },
    {
      name: `${folder}/transcript.md`,
      content:
        input.transcriptOverrideMd ??
        renderTranscriptMd(input.meeting, input.segments, { speakerNames: input.speakerNames, chapters: input.chapters }),
    },
    { name: `${folder}/notes.md`, content: renderNotesMd(input.meeting, input.notesMd) },
    {
      name: `${folder}/meeting.json`,
      content: renderMeetingJson({
        meeting: input.meeting,
        summary: input.summary,
        segments: input.segments,
        notesMd: input.notesMd,
        summaryOverrideMd: input.summaryOverrideMd,
        transcriptOverrideMd: input.transcriptOverrideMd,
      }),
    },
  ];
  if (input.audioMp3) files.push({ name: `${folder}/audio.mp3`, content: input.audioMp3.data });
  if (input.audioOriginal?.data) {
    files.push({ name: `${folder}/${input.audioOriginal.filename}`, content: input.audioOriginal.data });
  }
  return files;
}

type FullMeeting = Omit<NonNullable<Awaited<ReturnType<typeof getFull>>>, 'notes'> & {
  // A meeting may have no notes row (getFull's row type doesn't say so).
  notes: NonNullable<Awaited<ReturnType<typeof getFull>>>['notes'] | null;
};

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
