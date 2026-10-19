-- Folders become projects: standing context that steers transcription and
-- summaries, and rules for recognising the project from the active window.
ALTER TABLE `folders` ADD `about` text;
--> statement-breakpoint
ALTER TABLE `folders` ADD `vocabulary_json` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `folders` ADD `people` text;
--> statement-breakpoint
ALTER TABLE `folders` ADD `match_json` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `folders` ADD `created_at` integer;
--> statement-breakpoint
ALTER TABLE `folders` ADD `updated_at` integer;
--> statement-breakpoint
-- The transcript cleaned up for pasting into an AI agent, and whether the
-- recording was one person or a conversation.
ALTER TABLE `meetings` ADD `agent_transcript_md` text;
--> statement-breakpoint
ALTER TABLE `meetings` ADD `transcript_kind` text;
--> statement-breakpoint
CREATE INDEX `meetings_folder_idx` ON `meetings` (`folder_id`) WHERE `folder_id` IS NOT NULL;
