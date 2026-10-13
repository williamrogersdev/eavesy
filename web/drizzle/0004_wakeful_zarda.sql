ALTER TABLE `captures` ADD `transcript` text;--> statement-breakpoint
ALTER TABLE `captures` ADD `transcript_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `captures` ADD `transcript_error` text;