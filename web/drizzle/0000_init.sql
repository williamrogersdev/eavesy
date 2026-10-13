CREATE TABLE `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`meeting_id` text,
	`dictation_id` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activity_user_created_idx` ON `activity_log` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `calendar_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`account_email` text NOT NULL,
	`refresh_token_encrypted` text NOT NULL,
	`last_sync_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `connections_user_idx` ON `calendar_connections` (`user_id`);--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`title` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`meeting_url` text,
	`platform` text,
	`participants_json` text DEFAULT '[]' NOT NULL,
	`auto_record` integer DEFAULT false NOT NULL,
	`recorded_meeting_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `calendar_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_user_start_idx` ON `calendar_events` (`user_id`,`starts_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_connection_provider_uq` ON `calendar_events` (`connection_id`,`provider_event_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`root_folder_path` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `devices_user_idx` ON `devices` (`user_id`);--> statement-breakpoint
CREATE TABLE `dictations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`transcript` text NOT NULL,
	`cleaned_text` text,
	`applied_template_id` text,
	`target_app` text,
	`duration_sec` integer NOT NULL,
	`audio_r2_key` text,
	`local_folder_slug` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dictations_user_created_idx` ON `dictations` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`chunk_idx` integer NOT NULL,
	`content_excerpt` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `embeddings_user_idx` ON `embeddings` (`user_id`);--> statement-breakpoint
CREATE INDEX `embeddings_source_idx` ON `embeddings` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `folders_user_idx` ON `folders` (`user_id`);--> statement-breakpoint
CREATE TABLE `mcp_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`scopes_json` text DEFAULT '["read"]' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_tokens_user_idx` ON `mcp_tokens` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tokens_hash_uq` ON `mcp_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_sec` integer,
	`source` text NOT NULL,
	`platform` text,
	`language` text DEFAULT 'en' NOT NULL,
	`audio_r2_key` text,
	`audio_bytes` integer,
	`audio_duration_sec` integer,
	`audio_format` text,
	`calendar_event_id` text,
	`folder_id` text,
	`status` text NOT NULL,
	`status_error` text,
	`share_slug` text,
	`share_expires_at` integer,
	`expires_at` integer,
	`local_folder_slug` text,
	`device_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `meetings_user_started_idx` ON `meetings` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `meetings_status_idx` ON `meetings` (`status`);--> statement-breakpoint
CREATE INDEX `meetings_expires_idx` ON `meetings` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `meetings_share_slug_uq` ON `meetings` (`share_slug`);--> statement-breakpoint
CREATE TABLE `prompt_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`hotkey` text,
	`system_prompt` text NOT NULL,
	`applies_to` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `templates_user_idx` ON `prompt_templates` (`user_id`);--> statement-breakpoint
CREATE TABLE `speakers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`voice_fingerprint` text,
	`meeting_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `speakers_user_idx` ON `speakers` (`user_id`);--> statement-breakpoint
CREATE TABLE `summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`tldr` text NOT NULL,
	`decisions_json` text DEFAULT '[]' NOT NULL,
	`action_items_json` text DEFAULT '[]' NOT NULL,
	`follow_ups_json` text DEFAULT '[]' NOT NULL,
	`open_questions_json` text DEFAULT '[]' NOT NULL,
	`topics_json` text DEFAULT '[]' NOT NULL,
	`mentions_json` text DEFAULT '[]' NOT NULL,
	`generated_by_model` text NOT NULL,
	`template_id` text,
	`generated_at` integer NOT NULL,
	`user_edited_at` integer,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `summaries_meeting_id_unique` ON `summaries` (`meeting_id`);--> statement-breakpoint
CREATE TABLE `transcript_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`speaker_id` text,
	`text` text NOT NULL,
	`confidence` real,
	`is_edited` integer DEFAULT false NOT NULL,
	`is_final` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `segments_meeting_start_idx` ON `transcript_segments` (`meeting_id`,`start_ms`);--> statement-breakpoint
CREATE TABLE `user_notes` (
	`meeting_id` text PRIMARY KEY NOT NULL,
	`content_md` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`clerk_user_id` text,
	`email` text,
	`display_name` text,
	`byo_anthropic_key` text,
	`byo_deepgram_key` text,
	`default_transcription_engine` text DEFAULT 'deepgram' NOT NULL,
	`default_language` text DEFAULT 'en' NOT NULL,
	`is_anonymous` integer DEFAULT false NOT NULL,
	`anonymous_session_token` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_clerk_user_id_uq` ON `users` (`clerk_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_anonymous_token_uq` ON `users` (`anonymous_session_token`);--> statement-breakpoint
CREATE INDEX `users_email_idx` ON `users` (`email`);