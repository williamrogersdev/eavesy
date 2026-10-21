export interface TemplateField {
  key: string;
  label: string;
  hint: string;
  example: string;
}
export interface ResourceTemplate {
  title: string;
  intro: string;
  fields: TemplateField[];
}
export const RESOURCE_TEMPLATES: Record<string, ResourceTemplate> = {
  "ai-bug-report": {
    title: "Bug report",
    intro:
      "Describe one repeatable failure. Keep observed behavior separate from the result you expected.",
    fields: [
      {
        key: "goal",
        label: "Goal",
        hint: "What should the user be able to do?",
        example: "Export the visible rows after changing workspaces.",
      },
      {
        key: "environment",
        label: "Environment",
        hint: "App/build, OS/browser, and relevant starting state. Leave unchecked details unknown.",
        example: "Fictional workspace demo; Alpha selected; two ready rows.",
      },
      {
        key: "reproduction",
        label: "Reproduction steps",
        hint: "One action per line, starting before the failure.",
        example:
          "Open the workspace demo.\nConfirm Export is enabled in Alpha.\nSwitch to Beta.\nInspect Export while two rows remain visible.",
      },
      {
        key: "expected",
        label: "Expected behavior",
        hint: "State the intended result and why you expect it.",
        example: "Export remains available while exportable rows exist.",
      },
      {
        key: "observed",
        label: "Observed behavior",
        hint: "Describe what happened without guessing the cause.",
        example: "Export becomes disabled in Beta even though two rows remain.",
      },
      {
        key: "evidence",
        label: "Evidence",
        hint: "Accessible attachments or paths, plus exact source passages. Do not paste private credentials.",
        example:
          "Teaching fixture: https://eavesy.com/resources/examples/workspace-demo.html\nScreenshot: https://eavesy.com/resources/examples/workspace-beta.png",
      },
      {
        key: "limits",
        label: "Unknowns and request",
        hint: "What was not checked? What should the investigator verify?",
        example:
          "Cause not investigated. Inspect the disabled condition, explain the evidence, and test workspace changes and an empty state.",
      },
    ],
  },
  "decision-log": {
    title: "Decision log",
    intro:
      "Record one choice and the evidence for it. A proposal can stay a proposal.",
    fields: [
      {
        key: "decision",
        label: "Decision",
        hint: "One sentence stating the choice.",
        example: "Launch on Friday.",
      },
      {
        key: "status",
        label: "Status",
        hint: "Proposed, agreed, superseded, or needs confirmation.",
        example: "Agreed in the fictional source conversation.",
      },
      {
        key: "scope",
        label: "Date and scope",
        hint: "Project and actual decision date, if established.",
        example:
          "Launch planning. Exact calendar date and time zone not established.",
      },
      {
        key: "reasoning",
        label: "Reasoning",
        hint: "Only include reasons supported by the discussion.",
        example: "The source does not establish the reasoning.",
      },
      {
        key: "source",
        label: "Source and supporting excerpt",
        hint: "Recording or document, timestamp/section, and quotation.",
        example:
          "Fictional launch transcript, 00:01: “We agreed to launch on Friday.”",
      },
      {
        key: "followup",
        label: "Ownership and follow-up",
        hint: "Confirmed owner, next step, and agreed due date. Mark missing assignments.",
        example:
          "Help page review still needed; owner unassigned; deadline not stated.",
      },
      {
        key: "questions",
        label: "Open questions and later decisions",
        hint: "Unresolved details or a link to the decision that supersedes this one.",
        example: "Confirm the calendar date, release time, and review owner.",
      },
    ],
  },
  "meeting-action-items": {
    title: "Meeting action items",
    intro:
      "Separate accepted work from requests awaiting agreement. Use one task per line.",
    fields: [
      {
        key: "source",
        label: "Meeting and source",
        hint: "Title, date, and accessible recording/transcript reference.",
        example:
          "Fictional launch planning; https://eavesy.com/resources/examples/launch-transcript.md",
      },
      {
        key: "tasks",
        label: "Agreed tasks",
        hint: "For each task: action, owner, due date, source, and status. Write unassigned or not set when needed.",
        example: "No task owner or deadline is assigned in this source.",
      },
      {
        key: "requests",
        label: "Requests awaiting agreement",
        hint: "Keep ideas and unaccepted assignments here.",
        example:
          "Help page review is still needed (00:05). Owner explicitly unassigned (00:09).",
      },
      {
        key: "dependencies",
        label: "Dependencies",
        hint: "What must happen first? Keep unconfirmed dependencies explicit.",
        example:
          "The source does not establish whether the review blocks launch.",
      },
      {
        key: "review",
        label: "Review notes",
        hint: "What should be checked with participants before treating this as a commitment?",
        example:
          "Confirm who will review the help page, by when, and whether launch depends on it.",
      },
    ],
  },
};

export function buildTemplate(
  template: ResourceTemplate,
  values: Record<string, string>,
): string {
  return (
    `# ${template.title}\n\n` +
    template.fields
      .map(
        (field) =>
          `## ${field.label}\n\n${values[field.key]?.trim() || "[Not provided]"}\n`,
      )
      .join("\n") +
    "\n"
  );
}
