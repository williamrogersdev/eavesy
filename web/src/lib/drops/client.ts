import { copyText, isDesktop } from '@/lib/desktop/bridge';
import { isRecord } from '@/lib/json';

export interface Drop {
  id: string;
  kind: 'text' | 'file';
  text: string | null;
  preview: string | null;
  filename: string | null;
  contentType: string | null;
  bytes: number;
  deviceLabel: string | null;
  createdAt: number;
  contentUrl: string;
}

export type HubEvent =
  | { type: 'drop'; drop: Drop; origin: string | null }
  | { type: 'delete'; id: string; origin: string | null };

let cachedClientId: string | null = null;

/** Per-tab id so a tab can recognise its own drops when they echo back over the socket. */
export function clientId(): string {
  cachedClientId ??= crypto.randomUUID().replace(/-/g, '');
  return cachedClientId;
}

export function deviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Unknown device';
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Device';
  if (isDesktop()) return `${os} app`;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'browser';
  return `${os} · ${browser}`;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  // Header values are Latin-1 only; the label contains '·', so it travels percent-encoded.
  return { 'x-drop-client': clientId(), 'x-drop-device': encodeURIComponent(deviceLabel()), ...extra };
}

async function errorFrom(res: Response): Promise<Error> {
  const body: unknown = await res.json().catch(() => null);
  const message = isRecord(body) && typeof body.error === 'string' ? body.error : `request failed (${res.status})`;
  return new Error(message);
}

export async function fetchDrops(): Promise<Drop[]> {
  const res = await fetch('/api/drops', { cache: 'no-store' });
  if (!res.ok) throw await errorFrom(res);
  const body = await res.json<{ items: Drop[] }>();
  return body.items;
}

export async function sendText(text: string): Promise<Drop> {
  const res = await fetch('/api/drops', {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw await errorFrom(res);
  return (await res.json<{ drop: Drop }>()).drop;
}

/** XHR rather than fetch so large files can report upload progress. */
export function uploadFile(file: File, onProgress: (fraction: number) => void): Promise<Drop> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/drops/upload');
    for (const [k, v] of Object.entries(headers())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name || 'file'));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Fall through to the generic error below.
      }
      if (xhr.status >= 200 && xhr.status < 300 && isRecord(body) && isRecord(body.drop)) {
        resolve(body.drop as unknown as Drop);
      } else {
        const message = isRecord(body) && typeof body.error === 'string' ? body.error : `upload failed (${xhr.status})`;
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error('Network error while uploading'));
    xhr.send(file);
  });
}

export async function deleteDrop(id: string): Promise<void> {
  const res = await fetch(`/api/drops/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() });
  if (!res.ok && res.status !== 404) throw await errorFrom(res);
}

export async function liveTicket(): Promise<{ userId: string; ticket: string }> {
  const res = await fetch('/api/drops/ticket', { method: 'POST' });
  if (!res.ok) throw await errorFrom(res);
  return await res.json<{ userId: string; ticket: string }>();
}

/**
 * Copies a drop's text. Large drops aren't shipped inline, so their text is
 * fetched — handed to the clipboard as a pending ClipboardItem so Safari still
 * treats it as part of the click.
 */
export async function copyDropText(drop: Drop): Promise<void> {
  if (drop.text != null) {
    await writeClipboard(drop.text);
    return;
  }
  const pending = fetch(drop.contentUrl).then(async (res) => {
    if (!res.ok) throw await errorFrom(res);
    return await res.text();
  });
  if (!isDesktop() && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const blob = pending.then((text) => new Blob([text], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return;
    } catch {
      // Fall through to the plain-text paths below.
    }
  }
  await writeClipboard(await pending);
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await copyText(text);
  } catch (err) {
    // Async clipboard can be denied (permissions policy, embedded webviews);
    // the legacy copy command still works during the click's user activation.
    if (isDesktop() || !legacyCopy(text)) throw err;
  }
}

function legacyCopy(text: string): boolean {
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  el.style.position = 'fixed';
  el.style.opacity = '0';
  document.body.appendChild(el);
  el.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  el.remove();
  return ok;
}

export function downloadUrl(drop: Drop): string {
  return drop.kind === 'text' ? `${drop.contentUrl}?download` : drop.contentUrl;
}

export function isPreviewableImage(drop: Drop): boolean {
  return drop.kind === 'file' && /^image\/(png|jpeg|webp|gif|avif)$/.test(drop.contentType ?? '');
}

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
