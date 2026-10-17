import type { WorkersAiRunner } from '@/lib/ai/embed';
import type { TranscriptSegment } from '@/lib/transcription/types';
import type { SegmentTranscriber, SegmentTranscription } from '@/lib/transcription/provider';
import { audioBase64 } from '@/lib/transcription/base64';

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

export class WorkersAiSegmentTranscriber implements SegmentTranscriber {
  constructor(private readonly ai: WorkersAiRunner) {}

  async transcribe(args: {
    audio: Uint8Array;
    language?: string;
    contextBlurb?: string | null;
    /** Whisper's voice-activity filter. Off for mic-only clips, where it can cut quiet speech. */
    vadFilter?: boolean;
  }): Promise<SegmentTranscription> {
    const result = await this.ai.run(WHISPER_MODEL, {
      audio: audioBase64(args.audio),
      task: 'transcribe',
      language: args.language ?? 'en',
      vad_filter: args.vadFilter ?? true,
      condition_on_previous_text: false,
      initial_prompt: args.contextBlurb || undefined,
    });
    return mapResult(result, args.language);
  }
}

function mapResult(result: unknown, fallbackLanguage?: string): SegmentTranscription {
  const root = isRecord(result) ? result : {};
  const text = typeof root.text === 'string' ? root.text : '';
  const info = isRecord(root.transcription_info) ? root.transcription_info : {};
  const segments: TranscriptSegment[] = [];

  if (Array.isArray(root.segments)) {
    for (const candidate of root.segments) {
      if (!isRecord(candidate)) continue;
      const segmentText = typeof candidate.text === 'string' ? candidate.text.trim() : '';
      if (!segmentText) continue;
      const start = typeof candidate.start === 'number' ? candidate.start : 0;
      const end = typeof candidate.end === 'number' ? candidate.end : start;
      segments.push({
        startMs: Math.round(start * 1_000),
        endMs: Math.round(end * 1_000),
        text: segmentText,
        isFinal: true,
        ...(typeof candidate.no_speech_prob === 'number' ? { noSpeechProb: candidate.no_speech_prob } : {}),
        ...(typeof candidate.compression_ratio === 'number'
          ? { compressionRatio: candidate.compression_ratio }
          : {}),
      });
    }
  }

  if (segments.length === 0 && text.trim()) {
    const duration = typeof info.duration === 'number' ? info.duration : 0;
    segments.push({
      startMs: 0,
      endMs: Math.round(duration * 1_000),
      text: text.trim(),
      isFinal: true,
    });
  }

  return {
    text,
    segments,
    language: typeof info.language === 'string' ? info.language : fallbackLanguage,
    durationSec: typeof info.duration === 'number' ? info.duration : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
