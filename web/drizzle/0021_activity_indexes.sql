-- Kept apart from 0020: activity_log is the largest table, so these are the
-- slowest to build and add a write to every logged event. Only what the daily
-- rollup needs: the day's events by type, and a meeting's events. Per-user
-- look-backs use the existing activity_user_created_idx.
CREATE INDEX `activity_event_created_idx` ON `activity_log` (`event_type`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_meeting_idx` ON `activity_log` (`meeting_id`);
