ALTER TABLE `calendar_connections` ADD `scopes` text;--> statement-breakpoint
ALTER TABLE `calendar_connections` ADD `calendars_json` text;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `description` text;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `calendar_id` text;