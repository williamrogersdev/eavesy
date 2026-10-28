import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    clerkUserId: text('clerk_user_id'),
    email: text('email'),
    displayName: text('display_name'),
    byoAnthropicKey: text('byo_anthropic_key'),
    byoDeepgramKey: text('byo_deepgram_key'),
    byoOpenRouterKey: text('byo_openrouter_key'),
    byoOpenRouterConnectedAt: integer('byo_openrouter_connected_at'),
    openRouterPkceVerifier: text('openrouter_pkce_verifier'),
    defaultTranscriptionEngine: text('default_transcription_engine', {
      enum: ['whisper', 'deepgram'],
    })
      .notNull()
      // Historical SQL default retained to avoid a destructive users-table
      // rebuild; every application-level insert explicitly writes `whisper`.
      .default('deepgram'),
    defaultLanguage: text('default_language').notNull().default('en'),
    /** Words to recognize as spelled here (names, jargon), as a JSON array of strings. */
    customVocabularyJson: text('custom_vocabulary_json'),
    /** The languages the user speaks in recordings, as a JSON array of Whisper codes, most used first. */
    spokenLanguagesJson: text('spoken_languages_json'),
    /** The language notes are written in and transcripts translate to; null keeps the meeting's own. */
    notesLanguage: text('notes_language'),
    /** How dictations are rewritten before they are typed (see `DICTATION_STYLES`); null keeps the speaker's own words. */
    dictationStyle: text('dictation_style'),
    /** Whether dictations are structured as a prompt for an AI agent, in addition to their tone. */
    dictationForAgents: integer('dictation_for_agents', { mode: 'boolean' }).notNull().default(false),
    /** Whether a recap of each finished meeting is emailed to the account's own address. */
    emailRecaps: integer('email_recaps', { mode: 'boolean' }).notNull().default(false),
    /** Whether that recap carries the transcript as a text attachment. */
    emailRecapTranscript: integer('email_recap_transcript', { mode: 'boolean' }).notNull().default(false),
    isAnonymous: integer('is_anonymous', { mode: 'boolean' }).notNull().default(false),
    anonymousSessionToken: text('anonymous_session_token'),
    companyName: text('company_name'),
    role: text('role'),
    phoneNumber: text('phone_number'),
    onboardingCompletedAt: integer('onboarding_completed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('users_clerk_user_id_uq').on(t.clerkUserId),
    uniqueIndex('users_anonymous_token_uq').on(t.anonymousSessionToken),
    index('users_email_idx').on(t.email),
    index('users_created_idx').on(t.createdAt),
    index('users_onboarded_idx').on(t.onboardingCompletedAt),
    index('users_byo_keys_idx')
      .on(t.id)
      .where(
        sql`byo_anthropic_key IS NOT NULL OR byo_deepgram_key IS NOT NULL OR byo_openrouter_key IS NOT NULL`,
      ),
  ],
);

// Retained for history and unused: billing was removed and nothing reads or writes
// this table. Rows are kept; account deletion still clears them because of the
// user_id foreign key.
export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => users.id),
    plan: text('plan', { enum: ['free', 'pro', 'team'] }).notNull().default('free'),
    status: text('status', {
      enum: ['none', 'active', 'trialing', 'past_due', 'canceled', 'incomplete'],
    })
      .notNull()
      .default('none'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    stripePriceId: text('stripe_price_id'),
    seats: integer('seats').notNull().default(1),
    currentPeriodEnd: integer('current_period_end'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('subscriptions_stripe_customer_idx').on(t.stripeCustomerId),
    index('subscriptions_stripe_sub_idx').on(t.stripeSubscriptionId),
  ],
);

export const meetings = sqliteTable(
  'meetings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    contextBlurb: text('context_blurb'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    // When the first transcript line was stored; drives the latency metric.
    firstTranscriptAt: integer('first_transcript_at'),
    durationSec: integer('duration_sec'),
    source: text('source', {
      enum: ['desktop', 'web', 'public', 'ios', 'android', 'import', 'bot'],
    }).notNull(),
    platform: text('platform', {
      enum: ['zoom', 'meet', 'teams', 'in-person', 'phone', 'other'],
    }),
    language: text('language').notNull().default('en'),
    audioR2Key: text('audio_r2_key'),
    audioBytes: integer('audio_bytes'),
    audioDurationSec: integer('audio_duration_sec'),
    audioFormat: text('audio_format', { enum: ['m4a', 'opus', 'wav', 'mp3', 'webm'] }),
    calendarEventId: text('calendar_event_id'),
    folderId: text('folder_id'),
    status: text('status', {
      enum: ['recording', 'queued', 'uploading', 'processing', 'complete', 'failed'],
    }).notNull(),
    statusError: text('status_error'),
    shareSlug: text('share_slug'),
    shareExpiresAt: integer('share_expires_at'),
    expiresAt: integer('expires_at'),
    localFolderSlug: text('local_folder_slug'),
    deviceId: text('device_id'),
    clientSessionId: text('client_session_id'),
    rollingNotesAt: integer('rolling_notes_at'),
    /** When a job claimed the final summary, so two jobs never both call the model. */
    summaryClaimedAt: integer('summary_claimed_at'),
    speakerNamesJson: text('speaker_names_json'),
    summaryOverrideMd: text('summary_override_md'),
    transcriptOverrideMd: text('transcript_override_md'),
    agentTranscriptMd: text('agent_transcript_md'),
    transcriptKind: text('transcript_kind', { enum: ['solo', 'conversation'] }),
    localFilesUpdatedAt: integer('local_files_updated_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('meetings_user_started_idx').on(t.userId, t.startedAt),
    index('meetings_status_updated_idx').on(t.status, t.updatedAt),
    index('meetings_created_idx').on(t.createdAt),
    index('meetings_started_idx').on(t.startedAt),
    index('meetings_user_created_idx').on(t.userId, t.createdAt),
    index('meetings_deleted_idx').on(t.deletedAt).where(sql`deleted_at IS NOT NULL`),
    uniqueIndex('meetings_client_session_uq').on(t.clientSessionId),
    index('meetings_expires_idx').on(t.expiresAt),
    uniqueIndex('meetings_share_slug_uq').on(t.shareSlug),
    index('meetings_folder_idx').on(t.folderId).where(sql`folder_id IS NOT NULL`),
  ],
);

export const meetingSegments = sqliteTable(
  'meeting_segments',
  {
    id: text('id').primaryKey(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    track: text('track', { enum: ['mixed', 'mic', 'system'] }).notNull().default('mixed'),
    activeMs: integer('active_ms'),
    r2Key: text('r2_key').notNull(),
    bytes: integer('bytes').notNull(),
    offsetMs: integer('offset_ms').notNull(),
    durationMs: integer('duration_ms').notNull(),
    transcribeStatus: text('transcribe_status', {
      enum: ['pending', 'processing', 'complete', 'failed'],
    })
      .notNull()
      .default('pending'),
    transcribeClaimedAt: integer('transcribe_claimed_at'),
    /** Set each time this segment's lines are written; the live transcript cursor. */
    transcribedAt: integer('transcribed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('meeting_segments_meeting_idx_track_uq').on(t.meetingId, t.idx, t.track),
    index('meeting_segments_meeting_idx').on(t.meetingId, t.idx),
    index('meeting_segments_processing_idx')
      .on(t.transcribeClaimedAt)
      .where(sql`${t.transcribeStatus} = 'processing'`),
    // The recovery sweep's other half: segments whose transcription job was never queued.
    index('meeting_segments_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.transcribeStatus} = 'pending'`),
    index('meeting_segments_transcribed_idx')
      .on(t.meetingId, t.transcribedAt)
      .where(sql`${t.transcribedAt} IS NOT NULL`),
  ],
);

export const meetingUploads = sqliteTable('meeting_uploads', {
  meetingId: text('meeting_id')
    .primaryKey()
    .references(() => meetings.id, { onDelete: 'cascade' }),
  uploadId: text('upload_id').notNull(),
  partSize: integer('part_size').notNull(),
  nextPartNumber: integer('next_part_number').notNull().default(1),
  etagsJson: text('etags_json').notNull().default('[]'),
  state: text('state', { enum: ['active', 'completing', 'complete', 'failed'] })
    .notNull()
    .default('active'),
  updatedAt: integer('updated_at').notNull(),
});

export const transcriptSegments = sqliteTable(
  'transcript_segments',
  {
    id: text('id').primaryKey(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    speakerId: text('speaker_id'),
    text: text('text').notNull(),
    rawText: text('raw_text'),
    confidence: real('confidence'),
    /** The language this line was heard in, as a Whisper code. */
    language: text('language'),
    isEdited: integer('is_edited', { mode: 'boolean' }).notNull().default(false),
    isFinal: integer('is_final', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [index('segments_meeting_start_idx').on(t.meetingId, t.startMs)],
);

/** A transcript line translated into another language, kept while the line's text is unchanged. */
export const transcriptTranslations = sqliteTable(
  'transcript_translations',
  {
    segmentId: text('segment_id')
      .notNull()
      .references(() => transcriptSegments.id, { onDelete: 'cascade' }),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    language: text('language').notNull(),
    sourceText: text('source_text').notNull(),
    text: text('text').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.segmentId, t.language] }),
    index('translations_meeting_language_idx').on(t.meetingId, t.language),
  ],
);

export const summaries = sqliteTable(
  'summaries',
  {
    id: text('id').primaryKey(),
    meetingId: text('meeting_id')
      .notNull()
      .unique()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    tldr: text('tldr').notNull(),
    decisionsJson: text('decisions_json').notNull().default('[]'),
    actionItemsJson: text('action_items_json').notNull().default('[]'),
    followUpsJson: text('follow_ups_json').notNull().default('[]'),
    openQuestionsJson: text('open_questions_json').notNull().default('[]'),
    topicsJson: text('topics_json').notNull().default('[]'),
    mentionsJson: text('mentions_json').notNull().default('[]'),
    chaptersJson: text('chapters_json').notNull().default('[]'),
    generatedByModel: text('generated_by_model').notNull(),
    templateId: text('template_id'),
    generatedAt: integer('generated_at').notNull(),
    userEditedAt: integer('user_edited_at'),
  },
);

export const userNotes = sqliteTable('user_notes', {
  meetingId: text('meeting_id')
    .primaryKey()
    .references(() => meetings.id, { onDelete: 'cascade' }),
  contentMd: text('content_md').notNull().default(''),
  updatedAt: integer('updated_at').notNull(),
});

export const dictations = sqliteTable(
  'dictations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    transcript: text('transcript').notNull(),
    cleanedText: text('cleaned_text'),
    appliedTemplateId: text('applied_template_id'),
    targetApp: text('target_app'),
    durationSec: integer('duration_sec').notNull(),
    audioR2Key: text('audio_r2_key'),
    localFolderSlug: text('local_folder_slug'),
    createdAt: integer('created_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('dictations_user_created_idx').on(t.userId, t.createdAt),
    index('dictations_deleted_idx').on(t.deletedAt).where(sql`deleted_at IS NOT NULL`),
  ],
);

export const captures = sqliteTable(
  'captures',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind', { enum: ['image', 'video', 'audio', 'note'] }).notNull(),
    captureMode: text('capture_mode', {
      enum: ['screenshot', 'webcam', 'screen', 'audio', 'note'],
    }).notNull(),
    source: text('source', { enum: ['web', 'desktop', 'extension'] })
      .notNull()
      .default('web'),
    title: text('title').notNull(),
    r2Key: text('r2_key').notNull(),
    contentType: text('content_type').notNull(),
    bytes: integer('bytes').notNull(),
    durationSec: integer('duration_sec'),
    width: integer('width'),
    height: integer('height'),
    transcript: text('transcript'),
    transcriptStatus: text('transcript_status', {
      enum: ['none', 'pending', 'processing', 'complete', 'failed'],
    })
      .notNull()
      .default('none'),
    transcriptError: text('transcript_error'),
    folderId: text('folder_id'),
    // Desktop uploads: the Mac's own id for the capture (so retries don't
    // duplicate it and other Macs file it under the same id) and the device it came from.
    clientCaptureId: text('client_capture_id'),
    deviceId: text('device_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('captures_user_created_idx').on(t.userId, t.createdAt),
    uniqueIndex('captures_user_client_uq').on(t.userId, t.clientCaptureId),
    index('captures_deleted_idx').on(t.deletedAt).where(sql`deleted_at IS NOT NULL`),
  ],
);

// Cross-device "send to myself" inbox. Short text lives inline; files and
// oversized text live in R2 under users/{userId}/drops/.
export const drops = sqliteTable(
  'drops',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind', { enum: ['text', 'file'] }).notNull(),
    text: text('text'),
    // First few hundred chars, so list views never need to read R2.
    preview: text('preview'),
    r2Key: text('r2_key'),
    filename: text('filename'),
    contentType: text('content_type'),
    bytes: integer('bytes').notNull(),
    deviceLabel: text('device_label'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('drops_user_created_idx').on(t.userId, t.createdAt)],
);

export const promptTemplates = sqliteTable(
  'prompt_templates',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    description: text('description'),
    hotkey: text('hotkey'),
    systemPrompt: text('system_prompt').notNull(),
    appliesTo: text('applies_to', {
      enum: ['dictation', 'meeting', 'both'],
    }).notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('templates_user_idx').on(t.userId)],
);

/**
 * Text the user sends often, saved to paste from the panel or run as a slash
 * command through MCP. Unlike `prompt_templates`, which rewrite a capture,
 * these are sent as they are. `slug` is the command name, unique per account.
 */
export const savedPrompts = sqliteTable(
  'saved_prompts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    body: text('body').notNull(),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('saved_prompts_user_slug_uq').on(t.userId, t.slug)],
);

export const folders = sqliteTable(
  'folders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    parentId: text('parent_id'),
    sortOrder: integer('sort_order').notNull().default(0),
    about: text('about'),
    vocabularyJson: text('vocabulary_json').notNull().default('[]'),
    people: text('people'),
    matchJson: text('match_json').notNull().default('[]'),
    /** Dictation tone for this project (see `DICTATION_STYLES`); null uses the account's. */
    dictationStyle: text('dictation_style'),
    /** Whether dictations here are formatted for AI agents; null uses the account's. */
    dictationForAgents: integer('dictation_for_agents', { mode: 'boolean' }),
    createdAt: integer('created_at'),
    updatedAt: integer('updated_at'),
  },
  (t) => [index('folders_user_idx').on(t.userId)],
);

export const speakers = sqliteTable(
  'speakers',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    voiceFingerprint: text('voice_fingerprint'), // base64-encoded
    meetingCount: integer('meeting_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('speakers_user_idx').on(t.userId)],
);

export const calendarConnections = sqliteTable(
  'calendar_connections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    provider: text('provider', { enum: ['google', 'outlook'] }).notNull(),
    accountEmail: text('account_email').notNull(),
    refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),
    lastSyncAt: integer('last_sync_at'),
    /** When a sync last ran, whatever came of it; `lastSyncAt` only moves on success. */
    lastAttemptAt: integer('last_attempt_at'),
    /** How that attempt went: `reconnect` means Google refused the grant. */
    lastSyncStatus: text('last_sync_status', { enum: ['ok', 'reconnect', 'failed'] }),
  },
  (t) => [index('connections_user_idx').on(t.userId)],
);

export const calendarEvents = sqliteTable(
  'calendar_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    connectionId: text('connection_id')
      .notNull()
      .references(() => calendarConnections.id, { onDelete: 'cascade' }),
    providerEventId: text('provider_event_id').notNull(),
    title: text('title').notNull(),
    startsAt: integer('starts_at').notNull(),
    endsAt: integer('ends_at').notNull(),
    meetingUrl: text('meeting_url'),
    platform: text('platform'),
    participantsJson: text('participants_json').notNull().default('[]'),
    autoRecord: integer('auto_record', { mode: 'boolean' }).notNull().default(false),
    recordedMeetingId: text('recorded_meeting_id'),
  },
  (t) => [
    index('events_user_start_idx').on(t.userId, t.startsAt),
    uniqueIndex('events_connection_provider_uq').on(t.connectionId, t.providerEventId),
  ],
);

export const mcpTokens = sqliteTable(
  'mcp_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    name: text('name').notNull(),
    scopesJson: text('scopes_json').notNull().default('["read"]'),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
    expiresAt: integer('expires_at'),
    pathAuthUsedAt: integer('path_auth_used_at'),
    /** Set when the connection came from OAuth: its access token is short-lived and doesn't slide. */
    clientId: text('client_id'),
    refreshHash: text('refresh_hash'),
    refreshExpiresAt: integer('refresh_expires_at'),
  },
  (t) => [
    index('mcp_tokens_user_idx').on(t.userId),
    uniqueIndex('mcp_tokens_hash_uq').on(t.tokenHash),
    uniqueIndex('mcp_tokens_refresh_hash_uq').on(t.refreshHash),
  ],
);

/** Where an account's events are POSTed, signed with `secret` (Standard Webhooks). */
export const webhookEndpoints = sqliteTable(
  'webhook_endpoints',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    url: text('url').notNull(),
    description: text('description').notNull().default(''),
    secret: text('secret').notNull(),
    eventsJson: text('events_json').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    disabledAt: integer('disabled_at'),
    disabledReason: text('disabled_reason'),
    lastAttemptAt: integer('last_attempt_at'),
    lastSuccessAt: integer('last_success_at'),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    /** Events in a row that ran out of retries; the endpoint is turned off at WEBHOOK_DISABLE_AFTER. */
    failedEvents: integer('failed_events').notNull().default(0),
  },
  (t) => [index('webhook_endpoints_user_idx').on(t.userId)],
);

/** MCP clients registered through OAuth dynamic client registration. All are public (PKCE, no secret). */
export const oauthClients = sqliteTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  redirectUrisJson: text('redirect_uris_json').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** One-time OAuth authorization codes, stored hashed. */
export const oauthCodes = sqliteTable(
  'oauth_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    clientId: text('client_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    scopesJson: text('scopes_json').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
  },
  (t) => [index('oauth_codes_expires_idx').on(t.expiresAt)],
);

export const activityLog = sqliteTable(
  'activity_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    eventType: text('event_type').notNull(),
    meetingId: text('meeting_id'),
    dictationId: text('dictation_id'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('activity_user_created_idx').on(t.userId, t.createdAt),
    index('activity_event_created_idx').on(t.eventType, t.createdAt),
    index('activity_meeting_idx').on(t.meetingId),
  ],
);

export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    platform: text('platform', { enum: ['macos', 'windows', 'linux'] }).notNull(),
    rootFolderPath: text('root_folder_path').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('devices_user_idx').on(t.userId), index('devices_created_idx').on(t.createdAt)],
);

/**
 * What an agent on a remote MCP connection asked the user (`ask_human`) or told
 * them (`send_to_human`). A Mac with agent messages on picks each one up and
 * shows and speaks it; an answer goes back only to the call that asked. All
 * text here is the agent's and is shown and spoken, never run.
 */
export const agentMessages = sqliteTable(
  'agent_messages',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    /** The MCP connection that sent it. */
    mcpTokenId: text('mcp_token_id').notNull(),
    /** The connection's name when it was sent ("ChatGPT"), said before the message. */
    source: text('source').notNull(),
    kind: text('kind', { enum: ['send', 'ask'] }).notNull(),
    text: text('text').notNull(),
    spoken: text('spoken'),
    choicesJson: text('choices_json'),
    status: text('status', { enum: ['pending', 'delivered', 'answered', 'dismissed', 'timeout'] }).notNull(),
    answer: text('answer'),
    /** The Mac that showed it; no other Mac picks it up. */
    deviceId: text('device_id'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    resolvedAt: integer('resolved_at'),
    /** An ask's held call last said it's still waiting; an answer is taken only while it is. */
    heldAt: integer('held_at'),
  },
  (t) => [index('agent_messages_user_status_idx').on(t.userId, t.status, t.createdAt)],
);

/** Macs that are listening for agent messages, by when each last asked for them. */
export const agentListeners = sqliteTable(
  'agent_listeners',
  {
    deviceId: text('device_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    seenAt: integer('seen_at').notNull(),
  },
  (t) => [index('agent_listeners_user_idx').on(t.userId, t.seenAt)],
);

export const deviceTokens = sqliteTable(
  'device_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    uniqueIndex('device_tokens_hash_uq').on(t.tokenHash),
    index('device_tokens_user_idx').on(t.userId),
  ],
);

export const devicePairingCodes = sqliteTable(
  'device_pairing_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    deviceId: text('device_id').notNull(),
    name: text('name').notNull(),
    rootFolderPath: text('root_folder_path').notNull(),
    rawToken: text('raw_token'),
    claimedByUserId: text('claimed_by_user_id'),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('device_pairing_codes_expires_idx').on(t.expiresAt)],
);

export const contactMessages = sqliteTable(
  'contact_messages',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    topic: text('topic').notNull().default('general'),
    message: text('message').notNull(),
    handledAt: integer('handled_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('contact_messages_created_idx').on(t.createdAt)],
);

export const embeddings = sqliteTable(
  'embeddings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    sourceType: text('source_type', { enum: ['meeting', 'dictation'] }).notNull(),
    sourceId: text('source_id').notNull(),
    chunkIdx: integer('chunk_idx').notNull(),
    contentExcerpt: text('content_excerpt').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('embeddings_user_idx').on(t.userId),
    index('embeddings_source_idx').on(t.sourceType, t.sourceId),
  ],
);

export const productMetricsDaily = sqliteTable('product_metrics_daily', {
  date: text('date').primaryKey(),
  signups: integer('signups').notNull().default(0),
  onboardedUsers: integer('onboarded_users').notNull().default(0),
  pairedDevices: integer('paired_devices').notNull().default(0),
  usersFirstRecording: integer('users_first_recording').notNull().default(0),
  usersFirstTranscript: integer('users_first_transcript').notNull().default(0),
  usersFirstBriefUse: integer('users_first_brief_use').notNull().default(0),
  usersFirstReturn7d: integer('users_first_return_7d').notNull().default(0),
  meetingsStarted: integer('meetings_started').notNull().default(0),
  meetingsCompleted: integer('meetings_completed').notNull().default(0),
  meetingsBriefUsed: integer('meetings_brief_used').notNull().default(0),
  meetingsFailed: integer('meetings_failed').notNull().default(0),
  meetingsStuck: integer('meetings_stuck').notNull().default(0),
  processingSamples: integer('processing_samples').notNull().default(0),
  processingMsTotal: integer('processing_ms_total').notNull().default(0),
  processingMsMax: integer('processing_ms_max').notNull().default(0),
  firstTranscriptSamples: integer('first_transcript_samples').notNull().default(0),
  firstTranscriptMsTotal: integer('first_transcript_ms_total').notNull().default(0),
  firstTranscriptMsMax: integer('first_transcript_ms_max').notNull().default(0),
  audioSeconds: integer('audio_seconds').notNull().default(0),
  estimatedAiCostMicrousd: integer('estimated_ai_cost_microusd').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

export const rateLimits = sqliteTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('rate_limits_expires_idx').on(t.expiresAt)],
);

/** File imports are deduplicated within an owner, never across users. */
export const recordingImports = sqliteTable('recording_imports', {
  meetingId: text('meeting_id').primaryKey().references(() => meetings.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id),
  fingerprint: text('fingerprint').notNull(),
  segmentCount: integer('segment_count').notNull(),
  durationMs: integer('duration_ms').notNull(),
  // 'freeing': a cancelled import whose audio the hourly sweep is deleting; nothing may resume or finalize it until it is 'cancelled' again.
  state: text('state', { enum: ['uploading', 'processing', 'cancelled', 'freeing'] }).notNull().default('uploading'),
  createdAt: integer('created_at').notNull(),
}, (t) => [uniqueIndex('recording_imports_owner_fingerprint_uq').on(t.userId, t.fingerprint)]);

/** Conservative reservations are independent of Cloudflare's delayed invoice totals. */
export const aiCreditBudgets = sqliteTable('ai_credit_budgets', {
  scope: text('scope').primaryKey(), reservedMicrousd: integer('reserved_microusd').notNull().default(0),
});
export const aiCreditUsage = sqliteTable('ai_credit_usage', {
  id: text('id').primaryKey(), accountId: text('account_id').notNull(), model: text('model').notNull(), purpose: text('purpose').notNull(),
  reservedMicrousd: integer('reserved_microusd').notNull(), estimatedMicrousd: integer('estimated_microusd'), inputUnits: integer('input_units'), outputTokens: integer('output_tokens'),
  pricingVersion: text('pricing_version').notNull().default('2026-10-20'), state: text('state').notNull(), createdAt: integer('created_at').notNull(), finishedAt: integer('finished_at'),
}, (t) => [index('ai_credit_usage_created_idx').on(t.createdAt)]);

/** Human-confirmed speech corrections, scoped to the authenticated account. */
export const personalDictionary = sqliteTable('personal_dictionary', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  sourceKey: text('source_key').notNull(),
  from: text('from_text').notNull(),
  to: text('to_text').notNull(),
  /** 'manual' (typed in Settings) or 'learned' (from an edit); NULL rows predate tracking. */
  origin: text('origin').$type<'manual' | 'learned'>(),
  /** Times the same fix was made. A learned word steers transcription from the second, or once the user keeps it. */
  seen: integer('seen').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, t => [uniqueIndex('personal_dictionary_user_source_uq').on(t.userId, t.sourceKey)]);

/**
 * A notetaker bot sent to an online meeting: Eavesy's own (`eavesy`), or a
 * Recall.ai bot from before it (`recall`, kept for old rows; the hourly cron
 * fails any still on its way, since that service is gone). `provider_bot_id`
 * is the bot's own id for Eavesy's bots; it named the Recall bot before.
 * The meeting row is created once the bot starts recording; until then this row
 * is the user's request. Status only moves forward (see `BOT_STATUS_ORDER`);
 * `in_call` is only ever on old Recall rows.
 */
export const meetingBots = sqliteTable('meeting_bots', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  meetingId: text('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
  provider: text('provider', { enum: ['recall', 'eavesy'] }).notNull(),
  providerBotId: text('provider_bot_id'),
  meetingUrl: text('meeting_url').notNull(),
  platform: text('platform', { enum: ['zoom', 'meet', 'teams'] }).notNull(),
  title: text('title'),
  folderId: text('folder_id'),
  joinAt: integer('join_at'),
  status: text('status', {
    enum: ['scheduling', 'scheduled', 'joining', 'waiting_room', 'in_call', 'recording', 'call_ended', 'collecting', 'done', 'failed', 'cancelled'],
  }).notNull(),
  /** The provider's machine-readable reason for the latest status, when it gave one. */
  statusDetail: text('status_detail'),
  /** The bot's clock at the newest status applied; a report from before it is ignored. */
  statusAt: integer('status_at'),
  collectAttempts: integer('collect_attempts').notNull().default(0),
  /** The daily canary (meeting-bots/canary.ts): it never makes a meeting or keeps audio. */
  canary: integer('canary', { mode: 'boolean' }).notNull().default(false),
  /** Names a canary read off the call, participants and speakers; null until it got in. */
  canaryNames: integer('canary_names'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  index('meeting_bots_user_created_idx').on(t.userId, t.createdAt),
  uniqueIndex('meeting_bots_provider_bot_uq').on(t.provider, t.providerBotId),
  index('meeting_bots_status_updated_idx').on(t.status, t.updatedAt),
  index('meeting_bots_meeting_idx').on(t.meetingId),
]);

/** Provider webhook deliveries already applied, so a redelivery is a no-op. */
export const providerWebhookEvents = sqliteTable('provider_webhook_events', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  receivedAt: integer('received_at').notNull(),
}, (t) => [index('provider_webhook_events_received_idx').on(t.receivedAt)]);

/**
 * One email sent, or to be sent, through the transactional email provider.
 * `idempotency_key` is unique per meeting and recipient, so a retried job finds
 * the row it already made instead of sending again. `unknown` means a send was
 * attempted without a definite answer; it is never resent automatically, and a
 * later provider webhook can still settle it.
 */
export const emailDeliveries = sqliteTable('email_deliveries', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  meetingId: text('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
  kind: text('kind', { enum: ['meeting_recap'] }).notNull(),
  recipient: text('recipient').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  provider: text('provider', { enum: ['resend'] }).notNull(),
  providerMessageId: text('provider_message_id'),
  status: text('status', {
    enum: ['queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'unknown'],
  }).notNull(),
  /** Why the latest status was set: a provider bounce type, an error code, a skip reason. */
  statusDetail: text('status_detail'),
  /** Provider time of the newest event applied; older webhook deliveries are ignored. */
  statusAt: integer('status_at'),
  attempts: integer('attempts').notNull().default(0),
  sentAt: integer('sent_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  uniqueIndex('email_deliveries_idempotency_uq').on(t.idempotencyKey),
  uniqueIndex('email_deliveries_provider_message_uq').on(t.provider, t.providerMessageId),
  index('email_deliveries_user_created_idx').on(t.userId, t.createdAt),
  index('email_deliveries_recipient_status_idx').on(t.recipient, t.status),
  index('email_deliveries_status_updated_idx').on(t.status, t.updatedAt),
  index('email_deliveries_meeting_idx').on(t.meetingId),
]);
