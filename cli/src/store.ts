// Reads the Eavesy Recordings folder. The format is documented in
// web/src/content/docs/session-folder-format.mdx: one folder per capture, with
// `meeting.json` for recorded sessions and `capture.json` for clipboard notes,
// pasted images and screenshots (written by desktop/src-tauri/src/visual.rs).
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';

export const KINDS = ['meeting', 'note', 'image', 'screenshot', 'file'] as const;
export type Kind = (typeof KINDS)[number];

export interface CaptureFile {
  name: string;
  path: string;
  role: 'text' | 'media' | 'other';
  bytes: number;
}

export interface Capture {
  id: string;
  kind: Kind;
  title: string;
  /** ISO 8601. */
  date: string;
  startedAtMs: number;
  source: string;
  status: string;
  durationSeconds: number | null;
  folder: string;
  files: CaptureFile[];
}

export interface CaptureWithText extends Capture {
  /** Text files by name (summary.md, transcript.md, notes.md, note.md…). */
  text: Record<string, string>;
}

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_FOLDERS = 10_000;
const TEXT_EXTENSIONS = new Set(['.md', '.txt']);
const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.m4a', '.mp3', '.wav', '.mp4', '.mov', '.pdf']);
const MANIFESTS = new Set(['meeting.json', 'capture.json']);
/** What the desktop app writes before a summary or transcript exists (fs_writer.rs). */
const PLACEHOLDER = /^# (Brief|Transcript)\s+Eavesy is processing this recording\./;

export interface RootOptions {
  root?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}

/** Path of the Mac app's settings.json (Tauri app_config_dir). */
export function appSettingsPath(home = homedir()): string {
  return join(home, 'Library', 'Application Support', 'com.eavesy.desktop', 'settings.json');
}

export function readAppSettings(home = homedir()): Record<string, unknown> | null {
  try {
    const raw = readFileSync(appSettingsPath(home), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The Recordings folder: `--root`, then `EAVESY_RECORDINGS`, then the folder
 * chosen in the app's settings, then `~/Eavesy/Recordings`.
 */
export function resolveRoot(opts: RootOptions = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME ?? homedir();
  const expand = (p: string) => (p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p);
  if (opts.root?.trim()) return resolve(expand(opts.root.trim()));
  if (env.EAVESY_RECORDINGS?.trim()) return resolve(expand(env.EAVESY_RECORDINGS.trim()));
  const configured = readAppSettings(home)?.recordings_root;
  if (typeof configured === 'string' && configured.trim()) return resolve(expand(configured.trim()));
  return join(home, 'Eavesy', 'Recordings');
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (statSync(path).size > MAX_MANIFEST_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** The range `Date` can represent; anything outside it makes toISOString throw. */
const MAX_DATE_MS = 8.64e15;
const validTime = (value: number | null): value is number => value !== null && Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS;

export function kindOf(source: string): Kind {
  switch (source) {
    case 'note':
    case 'image':
    case 'screenshot':
    case 'file':
      return source;
    default:
      return 'meeting';
  }
}

function listFiles(folder: string): CaptureFile[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const files: CaptureFile[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.') || MANIFESTS.has(name)) continue;
    const path = join(folder, name);
    let stat;
    try {
      // lstat: a symlink could point anywhere on disk, so it is not part of the capture.
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const ext = extname(name).toLowerCase();
    const role = TEXT_EXTENSIONS.has(ext) ? 'text' : MEDIA_EXTENSIONS.has(ext) ? 'media' : 'other';
    files.push({ name, path, role, bytes: stat.size });
  }
  return files;
}

/** Reads one capture folder, or null when it has no manifest Eavesy wrote. */
export function readCapture(folder: string): Capture | null {
  const meeting = readJson(join(folder, 'meeting.json'));
  const capture = meeting ? null : readJson(join(folder, 'capture.json'));
  const manifest = meeting ?? capture;
  if (!manifest) return null;

  const id = str(manifest.id);
  if (!id) return null;
  const source = str(manifest.source) ?? 'unknown';
  let startedAtMs: number | null;
  if (meeting) {
    startedAtMs = num(meeting.startedAt) ?? (str(meeting.date) ? Date.parse(meeting.date as string) : null);
  } else {
    startedAtMs = num(manifest.started_at_ms);
  }
  if (!validTime(startedAtMs)) {
    try {
      const mtime = statSync(folder).mtimeMs;
      startedAtMs = validTime(mtime) ? mtime : 0;
    } catch {
      startedAtMs = 0;
    }
  }
  const duration = meeting ? num(meeting.durationSeconds) : num(manifest.duration_sec);
  return {
    id,
    kind: kindOf(source),
    title: str(manifest.title) ?? 'Untitled',
    date: new Date(startedAtMs).toISOString(),
    startedAtMs,
    source,
    status: str(manifest.status) ?? 'complete',
    durationSeconds: duration && duration > 0 ? duration : null,
    folder,
    files: listFiles(folder),
  };
}

/** Every capture under `root`, newest first. A missing root is an empty list. */
export function listCaptures(root: string): Capture[] {
  if (!existsSync(root)) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const captures: Capture[] = [];
  for (const entry of entries) {
    if (captures.length >= MAX_FOLDERS) break;
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const capture = readCapture(join(root, entry.name));
      if (capture) captures.push(capture);
    } catch {
      // One unreadable folder must not hide the rest.
    }
  }
  return captures.sort((a, b) => b.startedAtMs - a.startedAtMs || a.id.localeCompare(b.id));
}

export function readText(capture: Capture): Record<string, string> {
  const text: Record<string, string> = {};
  for (const file of capture.files) {
    if (file.role !== 'text' || file.bytes > MAX_TEXT_BYTES) continue;
    try {
      const content = readFileSync(file.path, 'utf8');
      if (!PLACEHOLDER.test(content.trim())) text[file.name] = content;
    } catch {
      // Unreadable files are listed but have no text.
    }
  }
  return text;
}

/**
 * Finds a capture by id, folder name, or an unambiguous id prefix (8+ chars).
 */
export function getCapture(root: string, ref: string): CaptureWithText | null {
  const key = ref.trim();
  if (!key) return null;
  const all = listCaptures(root);
  const exact =
    all.find((c) => c.id === key) ??
    all.find((c) => c.folder.split(/[\\/]/).pop() === key);
  let found = exact;
  if (!found && key.length >= 8) {
    const prefixed = all.filter((c) => c.id.startsWith(key));
    if (prefixed.length === 1) found = prefixed[0];
  }
  return found ? { ...found, text: readText(found) } : null;
}

export interface RecentOptions {
  kind?: Kind;
  limit?: number;
}

export function recent(root: string, opts: RecentOptions = {}): Capture[] {
  const limit = clampLimit(opts.limit, 20);
  return listCaptures(root)
    .filter((c) => !opts.kind || c.kind === opts.kind)
    .slice(0, limit);
}

export interface SearchHit {
  capture: Capture;
  score: number;
  /** The file the snippet came from, or "title". */
  matchedIn: string;
  snippet: string;
}

export interface SearchOptions extends RecentOptions {}

/** Case-insensitive match of every query term against title and text files. */
export function search(root: string, query: string, opts: SearchOptions = {}): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const limit = clampLimit(opts.limit, 20);
  const hits: SearchHit[] = [];
  for (const capture of listCaptures(root)) {
    if (opts.kind && capture.kind !== opts.kind) continue;
    const sources: [string, string][] = [['title', capture.title], ...Object.entries(readText(capture))];
    const lowered = sources.map(([name, body]) => [name, body.toLowerCase()] as const);
    if (!terms.every((term) => lowered.some(([, body]) => body.includes(term)))) continue;
    let score = 0;
    for (const [name, body] of lowered) {
      for (const term of terms) score += countOf(body, term) * (name === 'title' ? 5 : 1);
    }
    const [matchedIn, body] =
      sources.find(([name, text]) => name !== 'title' && text.toLowerCase().includes(terms[0])) ?? sources[0];
    hits.push({ capture, score, matchedIn, snippet: snippetAround(body, terms[0]) });
  }
  return hits
    .sort((a, b) => b.score - a.score || b.capture.startedAtMs - a.capture.startedAtMs)
    .slice(0, limit);
}

function countOf(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

export function snippetAround(text: string, term: string, width = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(term.toLowerCase());
  if (at === -1 || flat.length <= width) return flat.slice(0, width);
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + width).trim()}${start + width < flat.length ? '…' : ''}`;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}
