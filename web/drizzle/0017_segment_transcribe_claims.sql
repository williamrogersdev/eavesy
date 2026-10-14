ALTER TABLE `meeting_segments` ADD `transcribe_claimed_at` integer;
--> statement-breakpoint
CREATE INDEX `meeting_segments_processing_idx` ON `meeting_segments` (`transcribe_claimed_at`) WHERE `transcribe_status` = 'processing';
