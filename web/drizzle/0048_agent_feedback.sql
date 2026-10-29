CREATE TABLE `agent_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`mcp_token_id` text NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`target_label` text NOT NULL,
	`target_version` integer,
	`excerpt` text,
	`explanation` text NOT NULL,
	`suggested_rewrite` text,
	`status` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_feedback_user_dedupe_uq` ON `agent_feedback` (`user_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `agent_feedback_user_status_idx` ON `agent_feedback` (`user_id`,`status`,`target_type`,`target_id`);