ALTER TABLE `meetings` ADD `summary_claimed_at` integer;--> statement-breakpoint
CREATE INDEX `email_deliveries_meeting_idx` ON `email_deliveries` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `meeting_bots_meeting_idx` ON `meeting_bots` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `meeting_segments_pending_idx` ON `meeting_segments` (`created_at`) WHERE "meeting_segments"."transcribe_status" = 'pending';