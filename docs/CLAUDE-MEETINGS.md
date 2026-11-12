# Eavesy and Claude Meetings

Claude Meetings (Anthropic, beta from November 2026, Team and Enterprise
plans) adds Claude to a Google Meet call as a visible participant. It answers
in the Meet chat, builds docs and whiteboards during the call, and keeps
notes, action items and a transcript on a meeting page in Claude. It saves no
audio. Other platforms are announced, not shipped.

As of 2026-11-12, from Anthropic's pages below; the product is in beta and
these details may change.

Sources: <https://support.claude.com/en/articles/18325154-use-claude-meetings>,
<https://claude.com/resources/articles/claude-meetings>.

## What works together

| Eavesy | With Claude in the call |
| --- | --- |
| Mac app recording | Works. Eavesy adds nobody to the call, so Claude's guest rules don't apply. Anything Claude says aloud lands in the "Them" track; a doc it presents is caught as snapshots. |
| Eavesy Notetaker (the bot) | Works only where the organization allows outside guests. See below. |
| Eavesy connector (MCP) | Works. Claude can use a person's connectors during a call, with their approval, so "Claude, what did we decide last week?" can be answered from the Eavesy library (`search_meetings`, `get_meeting`, `get_action_items`). |
| Claude's notes into Eavesy | Not possible yet. Claude Meetings has no API, export or MCP access to its meeting pages. Anthropic lists transcript hand-off to other notetakers as coming soon. |

## The bot and Claude's guest rule

Claude treats anyone from outside the organization as an outside guest,
**another company's notetaker included**. Eavesy's bot joins signed out, so it
is one. Unless an owner has allowed meetings with external guests (off by
default on Enterprise, on by default on Team), Claude stays out of a call the
bot is invited to and leaves when the bot joins. When guests are allowed,
Claude keeps taking notes but stops replying in the Meet chat.

Eavesy can't change that from its side. For a call where Claude should stay,
record with the Mac app instead of sending the bot.

## What Eavesy does about Claude

- **Leaving.** Claude stays up to eight hours. The bot counts a call that
  holds only itself, Claude and other notetakers as empty and leaves after the
  usual minute (`workers/meeting-bot/bot/src/assistants.rs`). Because Claude is
  also a person's name, a bare "Claude" counts as software only after other
  people were in the call and left, and never while it has spoken in the last
  five minutes. The bot also stays whenever Meet's head count is larger than
  the tiles it can read.
- **Notes.** The summary prompt treats an assistant on the call as software:
  what it reported is kept, but it never owns an action item or a decision
  (`web/src/lib/ai/meeting-summary.ts`).

Claude's display name in a call isn't documented. The names matched are in
`CLAUDE_NAMES`; correct them once seen in a real call.

## Ideas worth taking

Not built. Listed in the order they'd pay off for Eavesy:

1. **Answer in the call's chat.** The bot posts one line today. Reading the
   chat for "Eavesy, …" and answering from the live transcript and the library
   is the heart of Claude Meetings, and Eavesy already has the rolling summary
   and "Ask Eavesy".
2. **Recap before the call ends.** Post decisions and action items in chat
   when asked, or when the scheduled end is near.
3. **Pause and resume.** "Stop listening" from the chat or the meeting page,
   for the off-the-record part of a call.
4. **Auto-join rules.** All meetings, or all except one-to-ones.
5. **Guest rule of our own.** An option to keep the bot out of calls with
   people outside the user's domain.
6. **Recap email** to the invited people in the user's workspace.
