ALTER TABLE `folders` ADD `team_id` text;--> statement-breakpoint
CREATE INDEX `folders_team_idx` ON `folders` (`team_id`) WHERE team_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `about` text;--> statement-breakpoint
ALTER TABLE `teams` ADD `vocabulary_json` text DEFAULT '[]' NOT NULL;