export const BRIEF_FORMATS = [
  {
    id: 'standard',
    name: 'Standard brief',
    description: 'Balanced decisions, action items, follow-ups, and open questions.',
    prompt: '',
  },
  {
    id: 'meeting',
    name: 'Meeting notes',
    description: 'Prioritizes decisions, owners, due dates, blockers, and unresolved questions.',
    prompt:
      'Format this as meeting notes. Prioritize decisions, owner-tagged action items, due dates, blockers, follow-ups, and unresolved questions. Omit sections with no evidence.',
  },
  {
    id: 'coding',
    name: 'Coding session',
    description: 'Captures the problem, attempted fixes, commands, files, evidence, and next steps.',
    prompt:
      'Format this as a coding-session handoff. Capture the goal, relevant architecture, files and commands explicitly mentioned, attempts and their outcomes, errors, decisions, remaining TODOs, and the exact next step. Never invent paths, commands, or test results.',
  },
  {
    id: 'research',
    name: 'Research session',
    description: 'Organizes questions, evidence, findings, sources mentioned, and uncertainty.',
    prompt:
      'Format this as a research brief. Separate the research question, evidence and sources explicitly mentioned, findings, competing explanations, open questions, confidence or uncertainty, and recommended next investigation. Do not fabricate citations.',
  },
  {
    id: 'customer',
    name: 'Customer conversation',
    description: 'Highlights goals, pain points, objections, commitments, and follow-up.',
    prompt:
      'Format this as a customer-conversation brief. Highlight the customer goal, current workflow, pain points, buying or adoption signals, objections, constraints, commitments, and next steps. Attribute claims only when the transcript makes the speaker clear.',
  },
] as const;

export type BriefFormatId = (typeof BRIEF_FORMATS)[number]['id'];

export function isBriefFormatId(value: unknown): value is BriefFormatId {
  return BRIEF_FORMATS.some((format) => format.id === value);
}

export function briefFormatPrompt(id: BriefFormatId): string | undefined {
  return BRIEF_FORMATS.find((format) => format.id === id)?.prompt || undefined;
}
