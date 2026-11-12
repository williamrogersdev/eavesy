import type Anthropic from '@anthropic-ai/sdk';
import { notesLanguageRule } from '@/lib/transcription/language';
import { CHAPTER_INSTRUCTIONS, CHAPTERS_SCHEMA } from './chapters';
import { MODELS, refusalFallback } from './client';
import { MEETING_CONTEXT_RULES } from '@/lib/meetings/meeting-context';

export const MEETING_SUMMARY_MODEL = MODELS.summary;
export const ROLLING_NOTES_MODEL = MODELS.rollingNotes;
/**
 * Rolling notes cover a few minutes of transcript and come back as a small
 * JSON object; this leaves room for Haiku's thinking at low effort while
 * capping a runaway reply far below the final summary's budget.
 */
export const ROLLING_NOTES_MAX_TOKENS = 8_000;

/** The model that writes this kind of summary. */
export function summaryModel(rolling: boolean, chosen?: string): string {
  return rolling ? ROLLING_NOTES_MODEL : chosen ?? MEETING_SUMMARY_MODEL;
}

const item = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string' } },
} as const;

export const MEETING_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'description',
    'tldr',
    'decisions',
    'actionItems',
    'followUps',
    'openQuestions',
    'topics',
    'mentions',
  ],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    tldr: { type: 'string' },
    decisions: { type: 'array', items: item },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'owner', 'due'],
        properties: {
          text: { type: 'string' },
          owner: { type: ['string', 'null'] },
          due: { type: ['string', 'null'] },
        },
      },
    },
    followUps: { type: 'array', items: item },
    openQuestions: { type: 'array', items: item },
    topics: { type: 'array', items: { type: 'string' } },
    mentions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['entity', 'type'],
        properties: {
          entity: { type: 'string' },
          type: { type: 'string', enum: ['person', 'product', 'company', 'project'] },
        },
      },
    },
  },
} as const;

export interface MeetingSummaryRequest {
  /** Told which model the API says wrote the final notes: another one after a decline. */
  onAnswered?: (model: string) => void;
  /** The Claude model for the final notes (`plan.summary.model`); absent is the default. Rolling notes keep their own. */
  model?: string;
  transcript: string;
  contextBlurb: string | null;
  priorSummary: string;
  rolling: boolean;
  recorderName?: string;
  /** The label on the call side's lines ("Them", or what the user renamed it), when the Mac recorded the call. */
  othersName?: string;
  /** Lines carry speaker labels: the Mac's two sides, or a notetaker bot's participants. */
  labelled?: boolean;
  /** What the calendar knew (`meetingContextBlock`): sent ahead of the transcript, as reference material. */
  meetingContext?: string;
  /** A meeting with other people (from the calendar, a notetaker, or the call's audio), not a voice note. */
  call?: boolean;
  chapters?: boolean;
  /** The language to write notes in; absent keeps the meeting's own. */
  notesLanguage?: string | null;
}

function schemaFor(args: MeetingSummaryRequest) {
  if (!args.chapters) return MEETING_SUMMARY_SCHEMA;
  return {
    ...MEETING_SUMMARY_SCHEMA,
    required: [...MEETING_SUMMARY_SCHEMA.required, 'chapters'],
    properties: { ...MEETING_SUMMARY_SCHEMA.properties, chapters: CHAPTERS_SCHEMA },
  };
}

export function meetingSummarySystemPrompt(args: MeetingSummaryRequest): string {
  const others = args.othersName ?? 'Them';
  const speakers = args.recorderName
    ? `Lines are prefixed with the speaker. "${args.recorderName}" is the person who recorded the meeting, speaking into their own microphone; "${others}" is everyone else on the call, possibly several people under one label. Tell those people apart only where the transcript makes it clear (someone is addressed by name, introduces themselves), and otherwise attribute to "${others}".`
    : args.othersName
      ? `Lines are prefixed with "${others}": everyone on the call except the person who recorded it, whose own microphone picked up nothing (they listened, or were muted). Several people can be behind that one label; tell them apart only where the transcript makes it clear.`
      : args.labelled
        ? 'Lines are prefixed with the speaker: each participant\'s name as the meeting platform showed it, or "Speaker N" when it showed none. Attribute decisions and action items to those speakers; do not invent other identities.'
        : 'No speaker labels are available. Do not invent speaker identities.';
  const kind = args.call
    ? 'This is a conversation between several people, not a voice note: write the notes as a record of what the participants discussed, decided and committed to.'
    : '';
  const context = args.contextBlurb
    ? `Context supplied by the user, to treat as ground truth:\n${args.contextBlurb}`
    : '';
  const prior = args.priorSummary
    ? `Prior rolling summary to refine without losing established facts:\n${args.priorSummary}`
    : '';
  return `You summarize a ${args.rolling ? 'rolling window from an ongoing' : 'completed'} meeting.

${speakers}
${kind}
${context}
${prior}
${args.meetingContext ? MEETING_CONTEXT_RULES : ''}

Rules:
- The TL;DR is at most 3 sentences.
- The title is 5-8 words.
- Action items are concrete commitments; include an owner only when the transcript makes it explicit.
- Decisions are concluded, not proposals still under debate.
- Do not invent facts or attribution. Omit anything the transcript does not support.
- An AI assistant or notetaker on the call (Claude added to the meeting, a participant named like a notetaker) is software, not an attendee, unless the transcript makes clear it is a person: keep what it reported or produced, but never make it the owner of an action item or the one who decided something. The owner is the person who asked it or took the work on, when the transcript says who.
- ${notesLanguageRule(args.notesLanguage)}${args.chapters ? `\n- ${CHAPTER_INSTRUCTIONS}` : ''}`;
}

/**
 * The message the notes are written from: the transcript, after the
 * calendar's context when there is some. The transcript is then wrapped too,
 * so the model can tell where the reference material ends.
 */
export function summaryUserContent(args: Pick<MeetingSummaryRequest, 'transcript' | 'meetingContext'>): string {
  if (!args.meetingContext) return args.transcript;
  const transcript = args.transcript.replace(/<(\/?transcript)/gi, '&lt;$1');
  return `${args.meetingContext}\n\n<transcript>\n${transcript}\n</transcript>`;
}

export function parseMeetingSummary(message: { stop_reason: string | null; content: readonly { type: string; text?: string }[] }) {
  if (message.stop_reason === 'refusal') throw new Error('summary refused by the model');
  if (message.stop_reason === 'max_tokens') throw new Error('summary truncated at max_tokens');
  const text = message.content
    .map((block) => (block.type === 'text' ? block.text ?? '' : ''))
    .join('');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`summary was not valid JSON (len=${text.length})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('summary was not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.tldr !== 'string' || !record.tldr.trim()) {
    throw new Error('summary had an empty TL;DR');
  }
  return record;
}

export async function requestMeetingSummary(client: Anthropic, args: MeetingSummaryRequest) {
  if (args.rolling) {
    // Streamed so a slow reply never runs into the SDK's non-streaming timeout.
    const message = await client.messages
      .stream({
        model: ROLLING_NOTES_MODEL,
        max_tokens: ROLLING_NOTES_MAX_TOKENS,
        system: meetingSummarySystemPrompt(args),
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: schemaFor(args) },
        },
        messages: [{ role: 'user', content: summaryUserContent(args) }],
      })
      .finalMessage();
    return parseMeetingSummary(message);
  }
  const model = args.model ?? MEETING_SUMMARY_MODEL;
  const message = await client.beta.messages.create({
    ...refusalFallback(model),
    model,
    max_tokens: 16_000,
    system: meetingSummarySystemPrompt(args),
    output_config: {
      format: { type: 'json_schema', schema: schemaFor(args) as unknown as Record<string, unknown> },
    },
    messages: [{ role: 'user', content: summaryUserContent(args) }],
  });
  args.onAnswered?.(message.model);
  return parseMeetingSummary(message);
}
