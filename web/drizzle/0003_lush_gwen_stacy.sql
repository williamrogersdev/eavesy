CREATE TABLE `captures` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`capture_mode` text NOT NULL,
	`source` text DEFAULT 'web' NOT NULL,
	`title` text NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`duration_sec` integer,
	`width` integer,
	`height` integer,
	`folder_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `captures_user_created_idx` ON `captures` (`user_id`,`created_at`);