/** Curated reading paths. Every link points to a maintained first-party page. */
export const RESOURCE_WORKFLOWS = [
  {
    title: "Show an agent a UI problem",
    description:
      "Capture one reproduction, assemble the evidence, and give your coding agent a concrete investigation.",
    steps: [
      {
        title: "Record the walkthrough",
        path: "/guides/screen-recording-to-markdown",
      },
      { title: "Build the bug report", path: "/templates/ai-bug-report" },
      { title: "Follow the worked example", path: "/examples/narrated-ui-bug" },
    ],
  },
  {
    title: "Keep a meeting useful afterward",
    description:
      "Check both audio sources, preserve the decisions, and carry confirmed tasks into your project notes.",
    steps: [
      {
        title: "Record both sides",
        path: "/guides/record-microphone-and-system-audio",
      },
      { title: "Review action items", path: "/templates/meeting-action-items" },
      { title: "Keep a Markdown note", path: "/examples/meeting-to-markdown" },
    ],
  },
  {
    title: "Recover a past decision",
    description:
      "Find the recording, check the supporting passage, and retain what is still unknown.",
    steps: [
      {
        title: "Find the decision",
        path: "/guides/find-decisions-in-recordings",
      },
      {
        title: "Check a cited answer",
        path: "/examples/library-answer-with-sources",
      },
      { title: "Write the decision log", path: "/templates/decision-log" },
    ],
  },
] as const;

export function readingMinutes(content: string): number {
  return Math.max(1, Math.ceil(content.trim().split(/\s+/).length / 200));
}
