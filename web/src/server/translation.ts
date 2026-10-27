import { translateText, translationInput } from '@/lib/translation/translate';
import { isLanguage } from '@/lib/translation/languages';
import { transcribeAudioFile } from '@/lib/transcription/transcribe-file';
import { wavDurationMs } from '@/lib/imports/wav';
import type { WorkersAiRunner } from '@/lib/ai/embed';

/** Voice requests use bounded, canonical PCM so credit accounting covers speech too. */
export async function translationRequest(request: Request, ai: WorkersAiRunner): Promise<Response> {
  let recognized: string | undefined;
  try {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: 'Missing translation.' }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2_600_000) return Response.json({ error: 'Recording is too large. Speak for up to 60 seconds.' }, { status: 413 });
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return Response.json({ error: 'Invalid translation request.' }, { status: 400 }); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return Response.json({ error: 'Invalid translation request.' }, { status: 400 });
    let input = value as Record<string, unknown>;
    if (input.audio !== undefined) {
      if (typeof input.audio !== 'string' || (!isLanguage(input.source) && input.source !== 'auto') || !isLanguage(input.target)) {
        return Response.json({ error: 'Invalid recording or language.' }, { status: 400 });
      }
      let audio;
      try {
        audio = Uint8Array.from(atob(input.audio), c => c.charCodeAt(0));
        if (wavDurationMs(audio) > 60_000) throw new Error('too long');
      } catch { return Response.json({ error: 'Use a recording of up to 60 seconds.' }, { status: 400 }); }
      const transcript = await transcribeAudioFile({ audio, language: input.source, voiceNote: true, ai });
      if (!transcript.text.trim()) return Response.json({ error: 'No speech heard. Please try again.' }, { status: 422 });
      recognized = transcript.text;
      input = { text: transcript.text, source: input.source, target: input.target };
    }
    try { translationInput(input); }
    catch (error) { return Response.json({ error: (error as Error).message, ...(recognized ? { text: recognized } : {}) }, { status: 400 }); }
    return Response.json(await translateText(ai, input), { headers: { 'cache-control': 'no-store' } });
  } catch {
    // Never forward provider responses or submitted text to logs or clients.
    return Response.json({ error: 'Translation is unavailable. Your text is still here; please try again.', ...(recognized ? { text: recognized } : {}) }, { status: 502 });
  }
}
