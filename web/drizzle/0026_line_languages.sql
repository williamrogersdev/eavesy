CREATE TABLE `transcript_translations` (
	`segment_id` text NOT NULL,
	`meeting_id` text NOT NULL,
	`language` text NOT NULL,
	`source_text` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`segment_id`, `language`),
	FOREIGN KEY (`segment_id`) REFERENCES `transcript_segments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `translations_meeting_language_idx` ON `transcript_translations` (`meeting_id`,`language`);--> statement-breakpoint
ALTER TABLE `transcript_segments` ADD `language` text;--> statement-breakpoint
ALTER TABLE `users` ADD `notes_language` text;