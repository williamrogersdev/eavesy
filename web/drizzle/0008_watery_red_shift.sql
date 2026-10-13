ALTER TABLE `meetings` ADD `client_session_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `meetings_client_session_uq` ON `meetings` (`client_session_id`);