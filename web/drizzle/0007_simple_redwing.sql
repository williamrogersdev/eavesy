CREATE TABLE `device_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_tokens_hash_uq` ON `device_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `device_tokens_user_idx` ON `device_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `meeting_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`idx` integer NOT NULL,
	`r2_key` text NOT NULL,
	`bytes` integer NOT NULL,
	`offset_ms` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`transcribe_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_segments_meeting_idx_uq` ON `meeting_segments` (`meeting_id`,`idx`);--> statement-breakpoint
CREATE INDEX `meeting_segments_meeting_idx` ON `meeting_segments` (`meeting_id`,`idx`);--> statement-breakpoint
CREATE TABLE `meeting_uploads` (
	`meeting_id` text PRIMARY KEY NOT NULL,
	`upload_id` text NOT NULL,
	`part_size` integer NOT NULL,
	`next_part_number` integer DEFAULT 1 NOT NULL,
	`etags_json` text DEFAULT '[]' NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `meetings` ADD `context_blurb` text;--> statement-breakpoint
ALTER TABLE `meetings` ADD `rolling_notes_at` integer;