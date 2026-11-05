CREATE TABLE `meeting_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`client_name` text NOT NULL,
	`offset_ms` integer NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`caption` text,
	`caption_model` text,
	`captioned_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_attachments_meeting_client_uq` ON `meeting_attachments` (`meeting_id`,`client_name`);--> statement-breakpoint
CREATE INDEX `meeting_attachments_meeting_offset_idx` ON `meeting_attachments` (`meeting_id`,`offset_ms`);--> statement-breakpoint
CREATE INDEX `meeting_attachments_uncaptioned_idx` ON `meeting_attachments` (`created_at`) WHERE "meeting_attachments"."captioned_at" IS NULL;