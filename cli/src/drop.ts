// `eavesy drop`: send text or a file to your Eavesy devices through the cloud
// when this Mac is signed in, otherwise save it as a local capture folder.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readAppSettings } from './store';

export const DEFAULT_BASE = 'https://eavesy.com';
/** Same service the Mac app stores its credential under (settings.rs). */
export const KEYCHAIN_SERVICE = 'com.eavesy.desktop.device-token.v2';
/** Matches MAX_FILE_BYTES in web/src/server/drops.ts. */
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic']);

export interface Credential {
  base: string;
  token: string;
}

export type DropInput = { kind: 'text'; text: string; title?: string } | { kind: 'file'; path: string; title?: string };

export interface DropResult {
  via: 'cloud' | 'local';
  /** Drop id (cloud) or capture id (local). */
  id: string;
  /** Local capture folder when saved locally. */
  folder?: string;
  /** Why a cloud send fell back to the local folder. */
  note?: string;
}

/**
 * The Keychain value is `<base>\n<token>`; a bare token predates self-hosting
 * and belongs to eavesy.com. The token is only ever sent to the base it is bound to.
 */
export function parseStoredCredential(stored: string): Credential | null {
  const value = stored.trim();
  if (!value) return null;
  const at = value.indexOf('\n');
  const [base, token] = at === -1 ? [DEFAULT_BASE, value] : [value.slice(0, at).trim(), value.slice(at + 1).trim()];
  return base && token ? { base: base.replace(/\/+$/, ''), token } : null;
}

export interface CredentialOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  /** Returns the raw Keychain value for the device id, or null. */
  readKeychain?: (account: string) => string | null;
}

/**
 * `EAVESY_DEVICE_TOKEN` (sent to `EAVESY_API_BASE` or eavesy.com), else the Mac
 * app's device credential from the Keychain. macOS may ask once before letting
 * this binary read it; deny and `drop` saves locally instead.
 */
export function findCredential(opts: CredentialOptions = {}): Credential | null {
  const env = opts.env ?? process.env;
  const fromEnv = env.EAVESY_DEVICE_TOKEN?.trim();
  if (fromEnv) return { base: (env.EAVESY_API_BASE?.trim() || DEFAULT_BASE).replace(/\/+$/, ''), token: fromEnv };
  if (env.EAVESY_NO_KEYCHAIN === '1') return null;
  const deviceId = readAppSettings(opts.home ?? env.HOME ?? homedir())?.device_id;
  if (typeof deviceId !== 'string' || !deviceId) return null;
  const stored = (opts.readKeychain ?? readSystemKeychain)(deviceId);
  return stored ? parseStoredCredential(stored) : null;
}

function readSystemKeychain(account: string): string | null {
  if (platform() !== 'darwin') return null;
  // The secret only travels over stdout, never on a command line.
  const result = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout : null;
}

export interface DropOptions {
  root: string;
  /** Skip the cloud even when signed in. */
  local?: boolean;
  credential?: Credential | null;
  fetch?: typeof fetch;
  now?: Date;
}

export async function drop(input: DropInput, opts: DropOptions): Promise<DropResult> {
  if (input.kind === 'file') {
    const stat = statSync(input.path);
    if (!stat.isFile()) throw new Error(`${input.path} is not a file`);
    if (stat.size > MAX_FILE_BYTES) throw new Error('file too large (100 MB max)');
  } else if (!input.text.trim()) {
    throw new Error('nothing to drop: the text is empty');
  }

  let note: string | undefined;
  const credential = opts.local ? null : opts.credential;
  if (credential) {
    const sent = await sendToCloud(input, credential, opts.fetch ?? fetch);
    if (sent.ok) return { via: 'cloud', id: sent.id };
    note = sent.reason;
  }
  return { ...saveLocal(input, opts.root, opts.now ?? new Date()), note };
}

type CloudOutcome = { ok: true; id: string } | { ok: false; reason: string };

async function sendToCloud(input: DropInput, credential: Credential, fetcher: typeof fetch): Promise<CloudOutcome> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential.token}`,
    'x-drop-client': 'cli',
    'x-drop-device': 'Eavesy CLI',
  };
  let response: Response;
  try {
    if (input.kind === 'text') {
      response = await fetcher(`${credential.base}/api/drops`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ text: input.text }),
      });
    } else {
      const body = readFileSync(input.path);
      response = await fetcher(`${credential.base}/api/drops/upload`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': contentTypeFor(input.path),
          'content-length': String(body.byteLength),
          'x-filename': encodeURIComponent(basename(input.path)),
        },
        body,
      });
    }
  } catch (error) {
    return { ok: false, reason: `could not reach ${credential.base} (${error instanceof Error ? error.message : String(error)})` };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: `${credential.base} did not accept this device's credential (HTTP ${response.status})` };
  }
  if (!response.ok) {
    const detail = await response.json().then((b: { error?: string }) => b?.error).catch(() => null);
    throw new Error(`drop failed: HTTP ${response.status}${detail ? ` (${detail})` : ''}`);
  }
  const body = (await response.json().catch(() => null)) as { drop?: { id?: string } } | null;
  return { ok: true, id: body?.drop?.id ?? 'unknown' };
}

export function contentTypeFor(path: string): string {
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.csv': 'text/csv',
  };
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Folder name rules match fs_writer.rs: `<date> <title>`, then `(HH-MM)`, then a counter. */
export function folderBaseName(title: string, now: Date): string {
  const safe = title
    .split('')
    .filter((ch) => ch.charCodeAt(0) < 128 && !'\\/:*?"<>|'.includes(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${localDate(now)} ${safe || 'Recording'}`;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function allocateFolder(root: string, title: string, now: Date): string {
  mkdirSync(root, { recursive: true });
  const base = folderBaseName(title, now);
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
  for (let attempt = 0; ; attempt++) {
    const name = attempt === 0 ? base : attempt === 1 ? `${base} (${time})` : `${base} (${time}-${attempt})`;
    const candidate = join(root, name);
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/** Writes a capture folder in the shape the Mac app's paste writes (`capture.json`). */
export function saveLocal(input: DropInput, root: string, now: Date): DropResult {
  const id = randomUUID();
  const isImage = input.kind === 'file' && IMAGE_EXTENSIONS.has(extname(input.path).toLowerCase());
  const source = input.kind === 'text' ? 'note' : isImage ? 'image' : 'file';
  const title =
    input.title?.trim() || (input.kind === 'text' ? 'Note' : basename(input.path, extname(input.path)) || 'File');
  const folder = allocateFolder(root, title, now);
  let fileName: string;
  if (input.kind === 'text') {
    fileName = 'note.md';
    writeFileSync(join(folder, fileName), input.text);
  } else {
    fileName = basename(input.path).replace(/^\.+/, '') || 'file';
    if (fileName === 'capture.json' || fileName === 'meeting.json') fileName = `dropped-${fileName}`;
    copyFileSync(input.path, join(folder, fileName));
  }
  const manifest = {
    id,
    title,
    started_at_ms: now.getTime(),
    duration_sec: 0,
    source,
    status: 'complete',
    summary: null,
    transcript: input.kind === 'text' ? input.text : null,
    notes: null,
    has_audio: false,
    has_video: false,
    folder_path: folder,
    file: fileName,
    origin: 'cli',
  };
  writeFileSync(join(folder, 'capture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { via: 'local', id, folder };
}
