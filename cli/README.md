# @eavesy/cli

Search your local [Eavesy](https://eavesy.com) captures (meetings, clipboard
notes, pasted images, screenshots) from the terminal or from any MCP client.
It reads the Recordings folder the Mac app writes, so it can reach captures that
never upload.

```bash
claude mcp add eavesy -- bunx @eavesy/cli mcp    # stdio MCP server
bunx @eavesy/cli search onboarding checklist
bunx @eavesy/cli recent --kind screenshot
bunx @eavesy/cli get <id>
pbpaste | bunx @eavesy/cli drop -
```

The Mac app bundles the same CLI. Turn it on in **Settings → Command line** to
link it to `~/.local/bin/eavesy`. Full docs: https://eavesy.com/docs/local-cli

## Development

```bash
bun install
bun test                # runs against test/fixtures/Recordings
bunx tsc --noEmit
bun run build           # dist/eavesy.js for npm (Node 18+)
bun run compile         # dist/eavesy, the single-file binary the app ships
```

The folder format is documented in
`web/src/content/docs/session-folder-format.mdx`. The desktop app writes it from
`desktop/src-tauri/src/fs_writer.rs` and `visual.rs`.
