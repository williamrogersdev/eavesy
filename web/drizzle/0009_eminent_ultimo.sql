CREATE TABLE `device_pairing_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`name` text NOT NULL,
	`root_folder_path` text NOT NULL,
	`raw_token` text,
	`claimed_by_user_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `device_pairing_codes_expires_idx` ON `device_pairing_codes` (`expires_at`);