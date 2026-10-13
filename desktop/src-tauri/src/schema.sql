CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  clerk_user_id TEXT,
  email TEXT,
  display_name TEXT,
  default_transcription_engine TEXT NOT NULL DEFAULT 'deepgram',
  default_language TEXT NOT NULL DEFAULT 'en',
  is_anonymous INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_sec INTEGER,
  source TEXT NOT NULL,
  platform TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  audio_r2_key TEXT,
  audio_bytes INTEGER,
  audio_duration_sec INTEGER,
  audio_format TEXT,
  status TEXT NOT NULL,
  status_error TEXT,
  share_slug TEXT,
  share_expires_at INTEGER,
  local_folder_slug TEXT,
  folder_id TEXT,
  device_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_meetings_user_started ON meetings(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  speaker_id TEXT,
  text TEXT NOT NULL,
  confidence REAL,
  is_edited INTEGER NOT NULL DEFAULT 0,
  is_final INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);
CREATE INDEX IF NOT EXISTS idx_segments_meeting_start ON transcript_segments(meeting_id, start_ms);

CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL UNIQUE,
  tldr TEXT NOT NULL,
  decisions_json TEXT NOT NULL DEFAULT '[]',
  action_items_json TEXT NOT NULL DEFAULT '[]',
  follow_ups_json TEXT NOT NULL DEFAULT '[]',
  open_questions_json TEXT NOT NULL DEFAULT '[]',
  topics_json TEXT NOT NULL DEFAULT '[]',
  mentions_json TEXT NOT NULL DEFAULT '[]',
  generated_by_model TEXT NOT NULL,
  template_id TEXT,
  generated_at INTEGER NOT NULL,
  user_edited_at INTEGER,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);

CREATE TABLE IF NOT EXISTS user_notes (
  meeting_id TEXT PRIMARY KEY,
  content_md TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);

CREATE TABLE IF NOT EXISTS dictations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  transcript TEXT NOT NULL,
  cleaned_text TEXT,
  applied_template_id TEXT,
  target_app TEXT,
  duration_sec INTEGER NOT NULL,
  audio_r2_key TEXT,
  local_folder_slug TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  hotkey TEXT,
  system_prompt TEXT NOT NULL,
  applies_to TEXT NOT NULL CHECK(applies_to IN ('dictation','meeting','both')),
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (parent_id) REFERENCES folders(id)
);

CREATE TABLE IF NOT EXISTS speakers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  voice_fingerprint BLOB,
  meeting_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS calendar_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('google','outlook')),
  account_email TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  last_sync_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  title TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  meeting_url TEXT,
  platform TEXT,
  participants_json TEXT NOT NULL DEFAULT '[]',
  auto_record INTEGER NOT NULL DEFAULT 0,
  recorded_meeting_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (connection_id) REFERENCES calendar_connections(id)
);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  meeting_id TEXT,
  dictation_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('macos','windows','linux')),
  root_folder_path TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pending_operations (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_flight','failed','done'))
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_operations(status, created_at);

CREATE TABLE IF NOT EXISTS filesystem_state (
  file_path TEXT PRIMARY KEY,
  meeting_id TEXT,
  dictation_id TEXT,
  file_role TEXT,
  last_written_at INTEGER,
  last_written_hash TEXT,
  last_observed_hash TEXT,
  last_observed_at INTEGER
);

CREATE TABLE IF NOT EXISTS recording_sessions (
  id TEXT PRIMARY KEY,
  remote_meeting_id TEXT,
  archive_path TEXT NOT NULL,
  segment_dir TEXT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  context_blurb TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  archive_bytes INTEGER,
  next_part_number INTEGER NOT NULL DEFAULT 1,
  next_archive_offset INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'recording'
    CHECK(status IN ('recording','uploading','finalizing','processing','complete','failed')),
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_status
  ON recording_sessions(status, updated_at);
