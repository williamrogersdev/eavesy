CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`url` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`secret` text NOT NULL,
	`events_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`disabled_at` integer,
	`disabled_reason` text,
	`last_attempt_at` integer,
	`last_success_at` integer,
	`last_status` integer,
	`last_error` text,
	`failed_events` integer DEFAULT 0 NOT NULL,
	`created_by_token_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `webhook_endpoints_user_idx` ON `webhook_endpoints` (`user_id`);