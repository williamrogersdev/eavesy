CREATE TABLE `email_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`meeting_id` text,
	`kind` text NOT NULL,
	`recipient` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`provider` text NOT NULL,
	`provider_message_id` text,
	`status` text NOT NULL,
	`status_detail` text,
	`status_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_deliveries_idempotency_uq` ON `email_deliveries` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_deliveries_provider_message_uq` ON `email_deliveries` (`provider`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `email_deliveries_user_created_idx` ON `email_deliveries` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `email_deliveries_recipient_status_idx` ON `email_deliveries` (`recipient`,`status`);--> statement-breakpoint
CREATE INDEX `email_deliveries_status_updated_idx` ON `email_deliveries` (`status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `email_recaps` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `email_recap_transcript` integer DEFAULT false NOT NULL;