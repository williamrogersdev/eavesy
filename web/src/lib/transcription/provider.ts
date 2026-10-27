import type { TranscriptSegment } from './types';

export interface SegmentTranscription {
  text: string;
  segments: TranscriptSegment[];
  language?: string;
  /** Whisper's confidence in `language` when it detected it, 0 to 1. */
  languageProbability?: number;
  durationSec?: number;
}

export interface SegmentTranscriber {
  transcribe(args: {
    audio: Uint8Array;
    language?: string;
    contextBlurb?: string | null;
    vocabulary?: readonly string[];
    vadFilter?: boolean;
  }): Promise<SegmentTranscription>;
}
