ALTER TABLE `captures` ADD `client_capture_id` text;--> statement-breakpoint
ALTER TABLE `captures` ADD `device_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `captures_user_client_uq` ON `captures` (`user_id`,`client_capture_id`);