ALTER TABLE `calendar_events` ADD `capture_mode` text;--> statement-breakpoint
ALTER TABLE `meeting_bots` ADD `calendar_event_id` text;--> statement-breakpoint
ALTER TABLE `meeting_bots` ADD `bot_name` text;--> statement-breakpoint
CREATE INDEX `meeting_bots_calendar_event_idx` ON `meeting_bots` (`calendar_event_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `meeting_capture_default` text DEFAULT 'mac' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `notetaker_name` text;--> statement-breakpoint
-- Carry each meeting's record/skip choice over to its capture mode; record_choice stays for older Mac apps.
UPDATE `calendar_events` SET `capture_mode` = CASE `record_choice` WHEN 'record' THEN 'mac' WHEN 'skip' THEN 'skip' END WHERE `record_choice` IS NOT NULL;
