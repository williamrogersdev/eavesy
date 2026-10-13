import { getCloudflareContext } from '@/server/cloudflare-context';
import type { TranscriptSegment } from './types';

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

export interface FileTranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  language?: string;
  durationSec?: number;
}

export interface FileTranscriptionRunner {
  run(model: string, input: unknown): Promise<unknown>;
}

export async function transcribeAudioFile(opts: {
  audio: Buffer | Uint8Array;
  language?: string;
  ai?: FileTranscriptionRunner;
}): Promise<FileTranscriptionResult> {
  const ai = opts.ai ?? aiFromRequestContext();
  if (!ai) {
    throw new Error('AI binding missing — add `[ai] binding = "AI"` to wrangler.toml');
  }

  const bytes = opts.audio instanceof Uint8Array ? opts.audio : new Uint8Array(opts.audio);

  const result = await ai.run(WHISPER_MODEL, {
    audio: toBase64(bytes),
    task: 'transcribe',
    language: opts.language ?? 'en',
  });

  return mapWhisperResult(result, opts.language);
}

function aiFromRequestContext(): FileTranscriptionRunner | undefined {
  const { env } = getCloudflareContext();
  return (env as unknown as { AI?: FileTranscriptionRunner }).AI;
}

export function mapWhisperResult(
  result: unknown,
  fallbackLanguage?: string,
): FileTranscriptionResult {
  if (!isRecord(result) || typeof result.text !== 'string') {
    throw new Error('Workers AI returned an invalid transcription response');
  }

  const text = result.text;
  const info = isRecord(result.transcription_info) ? result.transcription_info : {};
  const segments: TranscriptSegment[] = [];

  if (Array.isArray(result.segments) && result.segments.length > 0) {
    for (const s of result.segments) {
      if (!isRecord(s)) continue;
      const segText = typeof s.text === 'string' ? s.text.trim() : '';
      if (!segText) continue;
      segments.push({
        startMs: secondsToMilliseconds(s.start),
        endMs: secondsToMilliseconds(s.end),
        text: segText,
        isFinal: true,
      });
    }
  } else if (Array.isArray(result.words) && result.words.length > 0 && text.trim()) {
    const words = result.words.filter(isRecord);
    segments.push({
      startMs: secondsToMilliseconds(words[0]?.start),
      endMs: secondsToMilliseconds(words.at(-1)?.end),
      text: text.trim(),
      isFinal: true,
    });
  } else if (text.trim()) {
    segments.push({ startMs: 0, endMs: 0, text: text.trim(), isFinal: true });
  }

  return {
    text,
    segments,
    language: typeof info.language === 'string' ? info.language : fallbackLanguage,
    durationSec: finiteNumber(info.duration),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function secondsToMilliseconds(value: unknown): number {
  return Math.round((finiteNumber(value) ?? 0) * 1000);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
