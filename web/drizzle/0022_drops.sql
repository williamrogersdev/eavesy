CREATE TABLE `drops` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`preview` text,
	`r2_key` text,
	`filename` text,
	`content_type` text,
	`bytes` integer NOT NULL,
	`device_label` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `drops_user_created_idx` ON `drops` (`user_id`,`created_at`);