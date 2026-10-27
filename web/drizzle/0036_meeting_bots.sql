CREATE TABLE `meeting_bots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`meeting_id` text,
	`provider` text NOT NULL,
	`provider_bot_id` text,
	`meeting_url` text NOT NULL,
	`platform` text NOT NULL,
	`title` text,
	`folder_id` text,
	`join_at` integer,
	`status` text NOT NULL,
	`status_detail` text,
	`status_at` integer,
	`collect_attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `meeting_bots_user_created_idx` ON `meeting_bots` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_bots_provider_bot_uq` ON `meeting_bots` (`provider`,`provider_bot_id`);--> statement-breakpoint
CREATE INDEX `meeting_bots_status_updated_idx` ON `meeting_bots` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `provider_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `provider_webhook_events_received_idx` ON `provider_webhook_events` (`received_at`);
