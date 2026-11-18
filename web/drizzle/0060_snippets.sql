CREATE TABLE `snippets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`trigger_key` text NOT NULL,
	`trigger` text NOT NULL,
	`text` text NOT NULL,
	`field` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snippets_user_trigger_uq` ON `snippets` (`user_id`,`trigger_key`);