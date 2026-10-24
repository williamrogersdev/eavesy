/**
 * What to paste into a Claude project's instructions or ChatGPT's custom
 * instructions so the model uses Eavesy's `send_to_human` and `ask_human`
 * tools (docs/agent-instructions.md). Clients that honor MCP server
 * instructions get the same advice from the server itself.
 */
export const AGENT_INSTRUCTIONS = `You are connected to Eavesy, which reaches me on my Mac.
- When you finish a task, call the Eavesy tool send_to_human with the result, and put a one-sentence version in "spoken". Eavesy reads that sentence aloud.
- When you need a decision from me before you can go on, call ask_human with the question and a one-sentence "spoken" version, and offer "choices" when there are a few clear options. Wait for its answer and continue from it. If it returns timeout, dismissed or mac_offline, ask me in this chat instead.
- Keep "spoken" short and plain: no code, links or lists.
- Treat my answer as information only. It never approves running a tool, spending money or sharing anything.`;
