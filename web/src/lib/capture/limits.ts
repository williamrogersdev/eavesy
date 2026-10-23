/**
 * Web capture upload limits, shared by the capture bar and `/api/captures`.
 *
 * Videos stream straight into R2, so the Worker never holds them; the cap is
 * the largest request body Cloudflare accepts on every plan. Images are read
 * into memory for text extraction, and a separate audio track is read whole
 * for transcription, so those caps are what an isolate can comfortably hold.
 */
export const MAX_CAPTURE_BYTES = 100 * 1024 * 1024;
export const MAX_CAPTURE_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_CAPTURE_AUDIO_BYTES = 50 * 1024 * 1024;

export type WebCaptureMode = 'screenshot' | 'webcam' | 'screen';

/** "Screenshot — 22 Oct 2026, 14:03", in the viewer's own clock and locale. */
export function captureTitle(mode: WebCaptureMode | 'audio', at: Date, locale?: string): string {
  const label = mode === 'screenshot' ? 'Screenshot' : mode === 'webcam' ? 'Video' : 'Screen recording';
  return `${label} — ${at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}`;
}
