import { encodeWav, MAX_IMPORT_BYTES, MAX_IMPORT_SECONDS, SAMPLE_RATE, SEGMENT_SECONDS } from './wav';
export async function importFile(file: File, signal: AbortSignal, progress: (message: string, id?: string) => void) {
  if (!file.size || file.size > MAX_IMPORT_BYTES) throw new Error('Choose an audio file up to 100 MiB.');
  const formats: Record<string, string> = { m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', opus: 'audio/ogg' };
  const contentType = formats[file.name.split('.').pop()?.toLowerCase() ?? ''];
  if (!contentType) throw new Error('Choose M4A, MP3, WAV, WebM, Ogg or Opus audio.');
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(`/api/imports/${path}`, { ...init, signal });
    const body = await response.json<{ error?: string; meetingId?: string; state?: string; status?: string; uploaded?: number[] }>();
    if (!response.ok) throw new Error(body.error ?? 'Import failed');
    return body;
  };
  progress('Reading audio…');
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const fingerprint = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  let audio: AudioBuffer;
  try { audio = await context.decodeAudioData(bytes); } catch { throw new Error('Your browser could not decode this audio. Convert it to WAV or MP3 and retry.'); }
  finally { await context.close(); }
  if (!audio.length || audio.duration > MAX_IMPORT_SECONDS) throw new Error('Imports currently support audio up to 60 minutes.');
  if (audio.sampleRate !== SAMPLE_RATE) throw new Error('Browser did not provide the requested audio sample rate.');
  signal.throwIfAborted();
  const created = await call('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fingerprint, title: file.name.slice(0, 200), durationMs: Math.round(audio.duration * 1000) }) });
  const id = String(created.meetingId);
  progress('Preparing upload…', id);
  if (created.state === 'cancelled') await call(`${id}/resume`, { method: 'POST' });
  if (created.status === 'complete') { progress('Already in your library', id); return id; }
  if (created.state === 'processing') { progress('Already uploaded; processing continues in the cloud', id); return id; }
  const state = await call(id);
  const uploaded = new Set<number>(state.uploaded ?? []);
  const count = Math.ceil(audio.length / (SAMPLE_RATE * SEGMENT_SECONDS));
  for (let idx = 0; idx < count; idx++) {
    signal.throwIfAborted();
    progress(`Uploading audio ${idx + 1} of ${count}…`, id);
    if (uploaded.has(idx)) continue;
    const start = idx * SAMPLE_RATE * SEGMENT_SECONDS;
    const end = Math.min(audio.length, start + SAMPLE_RATE * SEGMENT_SECONDS);
    const samples = new Float32Array(end - start);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const values = audio.getChannelData(channel);
      for (let i = start; i < end; i++) samples[i - start] += values[i] / audio.numberOfChannels;
    }
    const wav = encodeWav(samples);
    await call(`${id}/segments/${idx}`, { method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: new Blob([wav as Uint8Array<ArrayBuffer>]) });
  }
  progress('Saving original audio…', id);
  await call(`${id}/archive`, { method: 'PUT', headers: { 'content-type': contentType }, body: file });
  await call(`${id}/finalize`, { method: 'POST' });
  progress('Uploaded; processing continues in the cloud', id);
  return id;
}
