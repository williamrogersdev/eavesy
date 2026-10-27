import { OPENROUTER_MODELS, openRouterChat } from '@/lib/providers/openrouter-chat';
import { notesLanguageRule } from '@/lib/transcription/language';
import { anthropic, anthropicForUser, MODELS } from './client';
import { isRecord } from '@/lib/json';

export interface SummaryDecision {
  text: string;
  sourceSegmentId?: string;
}

export interface SummaryActionItem {
  text: string;
  owner?: string;
  due?: string;
  sourceSegmentId?: string;
  completed: boolean;
}

export interface SummaryMention {
  entity: string;
  type: 'person' | 'product' | 'company' | 'project';
}

export interface MeetingSummary {
  title: string;
  description: string;
  tldr: string;
  decisions: SummaryDecision[];
  actionItems: SummaryActionItem[];
  followUps: SummaryDecision[];
  openQuestions: SummaryDecision[];
  topics: string[];
  mentions: SummaryMention[];
}

const SYSTEM_PROMPT = `You are a meeting summarizer. You produce structured, concise summaries from raw transcripts.

Hard rules:
- Be terse. The TL;DR is at most 3 sentences.
- Action items are concrete and actionable, with an owner when explicit in the transcript.
- Decisions are things actually decided in the meeting (not topics discussed).
- Open questions are things the participants explicitly left unresolved.
- Do not invent. If something wasn't mentioned, omit it.
- "title" is 5-8 words describing what was discussed. No quotes.
- "description" is 1-2 sentences summarizing purpose and outcome.

The user may attach their own notes from during the meeting. Treat those notes as steering signal — they highlight what the user thought was important.

Output strict JSON matching this schema (no prose, no markdown):
{
  "title": string,
  "description": string,
  "tldr": string,
  "decisions": [{ "text": string }],
  "actionItems": [{ "text": string, "owner": string | null, "due": string | null }],
  "followUps": [{ "text": string }],
  "openQuestions": [{ "text": string }],
  "topics": [string],
  "mentions": [{ "entity": string, "type": "person" | "product" | "company" | "project" }]
}`;

export interface SummarizeInput {
  transcript: string;
  userNotes?: string;
  contextBlurb?: string;
  /**
   * Who the speaker labels on the transcript's lines are, when it has them
   * (see `speakerNote`). Absent, the model is told not to invent speakers.
   */
  speakers?: string;
  byoApiKey?: string;
  openRouter?: { apiKey: string } | null;
  customTemplatePrompt?: string;
  /** The language to write notes in; absent keeps the meeting's own. */
  notesLanguage?: string | null;
}

/**
 * The sentence that tells the model what the speaker labels on a transcript
 * mean, matching how the pipeline's own prompt describes them
 * (`meetingSummarySystemPrompt`).
 */
export function speakerNote(rendered: { labelled: boolean; recorderName?: string }): string {
  if (rendered.recorderName) {
    return `Lines are prefixed with the speaker. "${rendered.recorderName}" is the person who recorded the meeting, speaking into their own microphone; the other label is everyone they spoke with over the call.`;
  }
  if (rendered.labelled) {
    return 'Lines are prefixed with the speaker: each participant\'s name as the meeting platform showed it, or "Speaker N" when it showed none. Attribute decisions and action items to those speakers; do not invent other identities.';
  }
  return 'No speaker labels are available. Do not invent speaker identities.';
}

/** The `generated_by_model` label for a brief `summarizeMeeting` wrote under this plan. */
export function summarizeMeetingModel(plan: { openRouter?: { apiKey: string } | null; summary: { apiKey?: string } }): string {
  if (plan.openRouter) return `openrouter:${OPENROUTER_MODELS.summary}`;
  return plan.summary.apiKey ? `byo-anthropic:${MODELS.summary}` : MODELS.summary;
}

export async function summarizeMeeting(input: SummarizeInput): Promise<MeetingSummary> {
  const userMessage = [
    input.contextBlurb
      ? `Meeting context supplied by the user. Treat this as ground truth and use it in place of absent speaker labels:\n${input.contextBlurb}`
      : null,
    input.speakers ?? null,
    input.customTemplatePrompt
      ? `Custom template instructions (override defaults where in conflict):\n${input.customTemplatePrompt}`
      : null,
    `Transcript:\n${input.transcript}`,
    input.userNotes ? `User notes (steering signal):\n${input.userNotes}` : null,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');

  const systemPrompt = `${SYSTEM_PROMPT}\n\nLanguage: ${notesLanguageRule(input.notesLanguage)}`;
  let text: string;
  if (input.openRouter) {
    text = await openRouterChat({
      apiKey: input.openRouter.apiKey,
      model: OPENROUTER_MODELS.summary,
      maxTokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });
  } else {
    const client = input.byoApiKey ? anthropicForUser(input.byoApiKey) : anthropic();
    const response = await client.messages.create({
      model: MODELS.summary,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    text = response.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  }

  return parseMeetingSummary(text);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function textItems(value: unknown): SummaryDecision[] {
  return asArray(value)
    .filter(isRecord)
    .map((item) => ({ text: asString(item.text).trim() }))
    .filter((item) => item.text.length > 0);
}

const MENTION_TYPES = new Set<SummaryMention['type']>([
  'person',
  'product',
  'company',
  'project',
]);

export function parseMeetingSummary(text: string): MeetingSummary {
  const parsed = parseJsonObject(text);

  const actionItems = asArray(parsed.actionItems)
    .filter(isRecord)
    .map((item): SummaryActionItem => ({
      text: asString(item.text).trim(),
      owner: asString(item.owner).trim() || undefined,
      due: asString(item.due).trim() || undefined,
      completed: false,
    }))
    .filter((item) => item.text.length > 0);

  const mentions = asArray(parsed.mentions)
    .filter(isRecord)
    .map((item): SummaryMention | null => {
      const entity = asString(item.entity).trim();
      if (!entity) return null;
      const type = asString(item.type);
      return {
        entity,
        type: MENTION_TYPES.has(type as SummaryMention['type'])
          ? (type as SummaryMention['type'])
          : 'person',
      };
    })
    .filter((item): item is SummaryMention => item !== null);

  return {
    title: asString(parsed.title, 'Untitled meeting').trim() || 'Untitled meeting',
    description: asString(parsed.description).trim(),
    tldr: asString(parsed.tldr).trim(),
    decisions: textItems(parsed.decisions),
    actionItems,
    followUps: textItems(parsed.followUps),
    openQuestions: textItems(parsed.openQuestions),
    topics: asArray(parsed.topics)
      .filter((topic): topic is string => typeof topic === 'string')
      .map((topic) => topic.trim())
      .filter(Boolean),
    mentions,
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (err) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
    } else {
      throw err;
    }
  }

  if (!isRecord(parsed)) {
    throw new Error('Summary provider returned JSON that was not an object');
  }
  return parsed;
}
