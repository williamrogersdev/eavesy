# Eavesy plugin for Claude Code

Connects Claude Code to [Eavesy](https://eavesy.com) so it can search your
recordings, dictations and action items, and adds a skill that tells Claude
when to look there.

## Install

```text
/plugin marketplace add williamrogersdev/eavesy
/plugin install eavesy@eavesy
```

The first time Claude uses the server, Claude Code opens a browser so you can
sign in to Eavesy and approve the connection (OAuth). There is no token to
paste. Run `/mcp` to check the connection or sign in again.

Without the plugin, the same server is one command:

```bash
claude mcp add --transport http eavesy https://mcp.eavesy.com
```

## What's in it

- `.mcp.json`: the hosted MCP server at `https://mcp.eavesy.com` (`http`
  transport, OAuth).
- `skills/eavesy-context`: when and how to use the Eavesy tools.

## Local server (coming)

A local stdio server that reads `~/Eavesy/Recordings` directly (including
clipboard notes and screenshots, which never leave your Mac) is planned as
part of the Eavesy CLI. JSON has no comments, so this is the slot.

Don't add it yet: the `eavesy` command doesn't exist until the CLI ships, and
Claude Code would show a failing server. Once it does, `.mcp.json` becomes:

```json
{
  "mcpServers": {
    "eavesy": {
      "type": "http",
      "url": "https://mcp.eavesy.com"
    },
    "eavesy-local": {
      "type": "stdio",
      "command": "eavesy",
      "args": ["mcp"]
    }
  }
}
```

Docs: https://eavesy.com/docs/connect-mcp
