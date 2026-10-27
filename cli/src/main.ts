import { serveStdio, summarize } from './mcp';
import { getCapture, isKind, KINDS, recent, resolveRoot, search, type Capture, type Kind } from './store';
import { VERSION } from './version';

export const USAGE = `eavesy ${VERSION}: your local Eavesy captures, for you and your agents

Usage:
  eavesy mcp                      Run a read-only stdio MCP server (search, get, recent)
  eavesy search <query…>          Search titles, notes, summaries and transcripts
  eavesy get <id>                 Print one capture (id, id prefix or folder name)
  eavesy recent [--kind <kind>]   List recent captures, newest first

Options:
  --root <dir>     Recordings folder (default: the app's setting, then ~/Eavesy/Recordings)
  --kind <kind>    ${KINDS.join(' | ')}
  --limit <n>      Maximum results (default 20)
  --json           Machine-readable output
  -h, --help       Show this help
  -v, --version    Show the version

Add it to Claude Code next to the hosted Eavesy server:
  claude mcp add eavesy-local --scope user -- node /path/to/eavesy/cli/dist/eavesy.js mcp
`;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  env: Record<string, string | undefined>;
}

interface Parsed {
  positionals: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(['root', 'kind', 'limit']);
const BOOLEAN_FLAGS = new Set(['json', 'help', 'version']);

export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h') flags.help = true;
    else if (arg === '-v') flags.version = true;
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) throw new UsageError(`unknown option: --${name}`);
      if (eq !== -1) flags[name] = arg.slice(eq + 1);
      else if (VALUE_FLAGS.has(name)) {
        const value = argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
        flags[name] = value;
      } else flags[name] = true;
    } else positionals.push(arg);
  }
  return { positionals, flags };
}

class UsageError extends Error {}

function flagString(flags: Parsed['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function kindFlag(flags: Parsed['flags']): Kind | undefined {
  const kind = flagString(flags, 'kind');
  if (kind === undefined) return undefined;
  if (!isKind(kind)) throw new UsageError(`--kind must be one of: ${KINDS.join(', ')}`);
  return kind;
}

function limitFlag(flags: Parsed['flags']): number | undefined {
  const raw = flagString(flags, 'limit');
  if (raw === undefined) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive whole number');
  return limit;
}

function line(capture: Capture): string {
  const date = capture.date.slice(0, 16).replace('T', ' ');
  return `${capture.id}  ${date}  ${capture.kind.padEnd(10)}  ${capture.title}`;
}

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { positionals, flags } = parsed;
  const [command, ...rest] = positionals;
  if (flags.version) {
    io.out(`${VERSION}\n`);
    return 0;
  }
  if (flags.help || !command || command === 'help') {
    io.out(USAGE);
    return command || flags.help ? 0 : 2;
  }

  try {
    const root = resolveRoot({ root: flagString(flags, 'root'), env: io.env });
    const json = flags.json === true;
    switch (command) {
      case 'mcp':
        await serveStdio(root);
        return 0;

      case 'search': {
        const query = rest.join(' ');
        if (!query.trim()) throw new UsageError('search needs a query');
        const hits = search(root, query, { kind: kindFlag(flags), limit: limitFlag(flags) });
        if (json) io.out(`${JSON.stringify(hits.map((h) => ({ ...summarize(h.capture), matchedIn: h.matchedIn, snippet: h.snippet })), null, 2)}\n`);
        else if (hits.length === 0) io.err(`No captures match "${query}" in ${root}\n`);
        else for (const hit of hits) io.out(`${line(hit.capture)}\n    ${hit.snippet}\n`);
        return 0;
      }

      case 'recent': {
        const captures = recent(root, { kind: kindFlag(flags), limit: limitFlag(flags) });
        if (json) io.out(`${JSON.stringify(captures.map(summarize), null, 2)}\n`);
        else if (captures.length === 0) io.err(`No captures in ${root}\n`);
        else for (const capture of captures) io.out(`${line(capture)}\n`);
        return 0;
      }

      case 'get': {
        if (rest.length !== 1) throw new UsageError('get needs exactly one id');
        const capture = getCapture(root, rest[0]);
        if (!capture) {
          io.err(`No capture with id ${rest[0]} in ${root}\n`);
          return 1;
        }
        if (json) {
          io.out(`${JSON.stringify({ ...summarize(capture), files: capture.files, text: capture.text }, null, 2)}\n`);
          return 0;
        }
        io.out(`# ${capture.title}\n\nid: ${capture.id}\nkind: ${capture.kind}\ndate: ${capture.date}\nfolder: ${capture.folder}\n`);
        const media = capture.files.filter((f) => f.role !== 'text');
        if (media.length) io.out(`files:\n${media.map((f) => `  ${f.path}`).join('\n')}\n`);
        for (const [name, body] of Object.entries(capture.text)) io.out(`\n--- ${name} ---\n${body.trimEnd()}\n`);
        return 0;
      }

      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    io.err(`eavesy: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
