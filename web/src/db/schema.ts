import {
  index,
  integer,
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
  ],
);

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
    durationSec: integer('duration_sec'),
    source: text('source', {
      enum: ['desktop', 'web', 'public', 'ios', 'android', 'import'],
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
    speakerNamesJson: text('speaker_names_json'),
    summaryOverrideMd: text('summary_override_md'),
    transcriptOverrideMd: text('transcript_override_md'),
    localFilesUpdatedAt: integer('local_files_updated_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('meetings_user_started_idx').on(t.userId, t.startedAt),
    index('meetings_status_idx').on(t.status),
    uniqueIndex('meetings_client_session_uq').on(t.clientSessionId),
    index('meetings_expires_idx').on(t.expiresAt),
    uniqueIndex('meetings_share_slug_uq').on(t.shareSlug),
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
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('meeting_segments_meeting_idx_track_uq').on(t.meetingId, t.idx, t.track),
    index('meeting_segments_meeting_idx').on(t.meetingId, t.idx),
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
    confidence: real('confidence'),
    isEdited: integer('is_edited', { mode: 'boolean' }).notNull().default(false),
    isFinal: integer('is_final', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [index('segments_meeting_start_idx').on(t.meetingId, t.startMs)],
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
  (t) => [index('dictations_user_created_idx').on(t.userId, t.createdAt)],
);

export const captures = sqliteTable(
  'captures',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind', { enum: ['image', 'video', 'audio'] }).notNull(),
    captureMode: text('capture_mode', {
      enum: ['screenshot', 'webcam', 'screen', 'audio'],
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [index('captures_user_created_idx').on(t.userId, t.createdAt)],
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
  },
  (t) => [
    index('mcp_tokens_user_idx').on(t.userId),
    uniqueIndex('mcp_tokens_hash_uq').on(t.tokenHash),
  ],
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
  (t) => [index('activity_user_created_idx').on(t.userId, t.createdAt)],
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
  (t) => [index('devices_user_idx').on(t.userId)],
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
  audioSeconds: integer('audio_seconds').notNull().default(0),
  estimatedAiCostMicrousd: integer('estimated_ai_cost_microusd').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});
