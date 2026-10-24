CREATE TABLE `agent_listeners` (
	`device_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`seen_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_listeners_user_idx` ON `agent_listeners` (`user_id`,`seen_at`);--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`mcp_token_id` text NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`spoken` text,
	`choices_json` text,
	`status` text NOT NULL,
	`answer` text,
	`device_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_messages_user_status_idx` ON `agent_messages` (`user_id`,`status`,`created_at`);