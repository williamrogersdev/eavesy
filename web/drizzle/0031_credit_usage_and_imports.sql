CREATE TABLE `recording_imports` (
	`meeting_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`segment_count` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`state` text DEFAULT 'uploading' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recording_imports_owner_fingerprint_uq` ON `recording_imports` (`user_id`,`fingerprint`);