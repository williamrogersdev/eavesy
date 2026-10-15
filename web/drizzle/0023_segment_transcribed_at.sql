-- When each segment's transcript was last written. Live transcript clients ask
-- for the time ranges transcribed since a cursor instead of the whole meeting.
ALTER TABLE `meeting_segments` ADD `transcribed_at` integer;
--> statement-breakpoint
CREATE INDEX `meeting_segments_transcribed_idx` ON `meeting_segments` (`meeting_id`,`transcribed_at`) WHERE `transcribed_at` IS NOT NULL;
