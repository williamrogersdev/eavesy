# @eavesy/cli

Search your local [Eavesy](https://eavesy.com) captures (meetings, clipboard
notes, pasted images, screenshots) from the terminal or from any MCP client.
It reads the Recordings folder the Mac app writes, so it can reach captures that
never upload. It only reads: nothing is sent anywhere and no credentials are
used.

It isn't published to npm or bundled in the Mac app yet. Run it from a checkout:

```bash
cd cli && bun install && bun run build      # dist/eavesy.js, Node 18+
node dist/eavesy.js recent --kind screenshot
node dist/eavesy.js search onboarding checklist
node dist/eavesy.js get <id>                # id, 8+ char id prefix, or folder name
```

## MCP

`eavesy mcp` is a read-only stdio MCP server with three tools, using the
canonical names from `docs/plans/agent-architecture.md`:

| Tool | What it does |
|---|---|
| `search` | Captures where every query word appears in the title or a text file. Filters by `kind`. |
| `recent` | The newest captures, optionally of one `kind`. |
| `get` | One capture's metadata and Markdown files. Screenshots and images are attached as MCP image content (4 MB each, 12 MB per call). |

Kinds are `meeting`, `note`, `image` and `screenshot`.

Add it next to the hosted `eavesy` server (the Claude Code plugin's), under a
different name:

```bash
claude mcp add eavesy-local --scope user -- node /path/to/eavesy/cli/dist/eavesy.js mcp
```

The Recordings folder is `--root <dir>`, then `EAVESY_RECORDINGS`, then the
folder chosen in the app's settings, then `~/Eavesy/Recordings`.

## Development

```bash
bun install
bun test                # runs against test/fixtures/Recordings
bunx tsc --noEmit
bun run build
```

The folder format is documented in
`web/src/content/docs/session-folder-format.mdx`. The desktop app writes it from
`desktop/src-tauri/src/fs_writer.rs`, `visual.rs` and `imports.rs`.
