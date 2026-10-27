import type Anthropic from '@anthropic-ai/sdk';
import { notesLanguageRule } from '@/lib/transcription/language';
import { CHAPTER_INSTRUCTIONS, CHAPTERS_SCHEMA } from './chapters';
import { MODELS } from './client';

export const MEETING_SUMMARY_MODEL = MODELS.summary;
export const ROLLING_NOTES_MODEL = MODELS.rollingNotes;
/**
 * Rolling notes cover a few minutes of transcript and come back as a small
 * JSON object; this leaves room for Haiku's thinking at low effort while
 * capping a runaway reply far below the final summary's budget.
 */
export const ROLLING_NOTES_MAX_TOKENS = 8_000;

/** The model that writes this kind of summary. */
export function summaryModel(rolling: boolean): string {
  return rolling ? ROLLING_NOTES_MODEL : MEETING_SUMMARY_MODEL;
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
  transcript: string;
  contextBlurb: string | null;
  priorSummary: string;
  rolling: boolean;
  recorderName?: string;
  /** Lines carry participants' names (a notetaker bot's diarization) rather than the Mac's two sides. */
  labelled?: boolean;
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
  const speakers = args.recorderName
    ? `Lines are prefixed with the speaker. "${args.recorderName}" is the person who recorded the meeting, speaking into their own microphone; the other label is everyone they spoke with over the call.`
    : args.labelled
      ? 'Lines are prefixed with the speaker: each participant\'s name as the meeting platform showed it, or "Speaker N" when it showed none. Attribute decisions and action items to those speakers; do not invent other identities.'
      : 'No speaker labels are available. Do not invent speaker identities.';
  const context = args.contextBlurb
    ? `Context supplied by the user, to treat as ground truth:\n${args.contextBlurb}`
    : '';
  const prior = args.priorSummary
    ? `Prior rolling summary to refine without losing established facts:\n${args.priorSummary}`
    : '';
  return `You summarize a ${args.rolling ? 'rolling window from an ongoing' : 'completed'} meeting.

${speakers}
${context}
${prior}

Rules:
- The TL;DR is at most 3 sentences.
- The title is 5-8 words.
- Action items are concrete commitments; include an owner only when the transcript makes it explicit.
- Decisions are concluded, not proposals still under debate.
- Do not invent facts or attribution. Omit anything the transcript does not support.
- ${notesLanguageRule(args.notesLanguage)}${args.chapters ? `\n- ${CHAPTER_INSTRUCTIONS}` : ''}`;
}

export function parseMeetingSummary(message: Pick<Anthropic.Message, 'stop_reason' | 'content'>) {
  if (message.stop_reason === 'refusal') throw new Error('summary refused by the model');
  if (message.stop_reason === 'max_tokens') throw new Error('summary truncated at max_tokens');
  const text = message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
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
        messages: [{ role: 'user', content: args.transcript }],
      })
      .finalMessage();
    return parseMeetingSummary(message);
  }
  const message = await client.messages.create({
    model: MEETING_SUMMARY_MODEL,
    max_tokens: 16_000,
    system: meetingSummarySystemPrompt(args),
    output_config: {
      format: { type: 'json_schema', schema: schemaFor(args) as unknown as Record<string, unknown> },
    },
    messages: [{ role: 'user', content: args.transcript }],
  });
  return parseMeetingSummary(message);
}
