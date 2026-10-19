import { getCloudflareContext } from '@/server/cloudflare-context';
import type { TranscriptSegment } from './types';
import { audioBase64 } from './base64';
import { whisperLanguage } from './language';
import { isHallucination } from './two-track';
import { whisperPrompt } from './vocabulary';

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

/**
 * Transcribes a whole file and drops the lines Whisper invents on silence.
 * `voiceNote` is for the user's own mic alone (a dictation, a voice note): a
 * short "thank you" there can be real, and if Whisper's VAD cuts quiet speech
 * down to nothing the clip gets one more pass without it.
 */
export async function transcribeAudioFile(opts: {
  audio: Buffer | Uint8Array;
  language?: string | null;
  contextBlurb?: string | null;
  vocabulary?: readonly string[];
  voiceNote?: boolean;
  ai?: FileTranscriptionRunner;
}): Promise<FileTranscriptionResult> {
  const ai = opts.ai ?? aiFromRequestContext();
  if (!ai) {
    throw new Error('AI binding missing — add `[ai] binding = "AI"` to wrangler.toml');
  }

  const bytes = opts.audio instanceof Uint8Array ? opts.audio : new Uint8Array(opts.audio);
  const language = whisperLanguage(opts.language);
  const prompt = whisperPrompt({ contextBlurb: opts.contextBlurb, vocabulary: opts.vocabulary });
  const run = async (vadFilter: boolean) =>
    mapWhisperResult(
      await ai.run(WHISPER_MODEL, {
        audio: audioBase64(bytes),
        task: 'transcribe',
        ...(language ? { language } : {}),
        vad_filter: vadFilter,
        condition_on_previous_text: false,
        ...(prompt ? { initial_prompt: prompt } : {}),
      }),
      language,
    );

  const first = await run(true);
  const heard = keepHeard(first, { lenient: opts.voiceNote });
  if (heard.segments.length > 0 || !opts.voiceNote) return heard;
  return keepHeard(await run(false), { lenient: false });
}

function keepHeard(result: FileTranscriptionResult, opts: { lenient?: boolean }): FileTranscriptionResult {
  const segments = result.segments.filter((segment) => !isHallucination(segment, opts));
  return { ...result, segments, text: segments.map((segment) => segment.text).join(' ') };
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
      const noSpeechProb = finiteNumber(s.no_speech_prob);
      const compressionRatio = finiteNumber(s.compression_ratio);
      segments.push({
        startMs: secondsToMilliseconds(s.start),
        endMs: secondsToMilliseconds(s.end),
        text: segText,
        isFinal: true,
        ...(noSpeechProb !== undefined ? { noSpeechProb } : {}),
        ...(compressionRatio !== undefined ? { compressionRatio } : {}),
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
