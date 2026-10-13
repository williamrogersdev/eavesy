DROP INDEX `meeting_segments_meeting_idx_uq`;--> statement-breakpoint
ALTER TABLE `meeting_segments` ADD `track` text DEFAULT 'mixed' NOT NULL;--> statement-breakpoint
ALTER TABLE `meeting_segments` ADD `active_ms` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_segments_meeting_idx_track_uq` ON `meeting_segments` (`meeting_id`,`idx`,`track`);--> statement-breakpoint
ALTER TABLE `meetings` ADD `speaker_names_json` text;