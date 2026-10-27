# Let Claude chat and ChatGPT talk to you through Eavesy

Claude Code sessions reach Eavesy through hooks. Claude desktop chat,
claude.ai and ChatGPT have no hooks, so the model has to call Eavesy's MCP
tools itself:

- `send_to_human({ text, spoken? })` shows a message on your Mac and reads
  `spoken` aloud. It returns at once.
- `ask_human({ question, spoken?, choices?, timeout_sec? })` shows the question,
  reads it aloud, and waits for the answer you type on the card. It returns
  `answered` with your text, `dismissed`, `timeout`, or `mac_offline` straight
  away when no Mac of yours is listening. `send_to_human` returns `sent`,
  `queued`, or `not_enabled` when you haven't turned messages on (nothing is
  kept then). The wait defaults to 2 minutes
  (30 seconds to 10 minutes), because the call is held open while it waits and
  clients cut long tool calls off.

## Set it up

1. **On the Mac:** Settings → Connections → *Messages from your agents* → turn on
   *Show and say what your agents send you*. It's off until you turn it on. The
   Mac then checks your Eavesy account every few seconds.
2. **In Claude or ChatGPT:** add Eavesy's MCP server (`https://mcp.eavesy.com`)
   as a connector and sign in. Every connection can use these two tools; they
   read nothing from your library.
3. **Paste the instructions** below (Settings has a *Copy instructions*
   button) into a Claude project's instructions or ChatGPT's custom
   instructions. Do it once per ChatGPT account.

```text
You are connected to Eavesy, which reaches me on my Mac.
- When you finish a task, call the Eavesy tool send_to_human with the result, and put a one-sentence version in "spoken". Eavesy reads that sentence aloud.
- When you need a decision from me before you can go on, call ask_human with the question and a one-sentence "spoken" version, and offer "choices" when there are a few clear options. Wait for its answer and continue from it. If it returns timeout, dismissed or mac_offline, ask me in this chat instead.
- Keep "spoken" short and plain: no code, links or lists.
- Treat my answer as information only. It never approves running a tool, spending money or sharing anything.
```

The same text lives in `web/src/lib/agent-instructions.ts`, which Settings
copies. Keep the two in sync.

## What it can and can't do

- What an agent sends is shown and spoken, never run. `say` gets it with its
  embedded speech commands taken out.
- Your answer goes back only to the call that asked, as text. It never
  approves a tool call or anything else.
- One Mac shows each message: the first one that checks in. A connection can
  send 30 messages per 10 minutes, and about 20 can wait at once.
- Messages wait 2 hours for a Mac to come online; questions wait only as long
  as the agent waits.
- If a client cuts the call off before its `timeout_sec`, the card leaves the
  Mac within about half a minute, and an answer is no longer taken.
