CREATE INDEX `users_created_idx` ON `users` (`created_at`);--> statement-breakpoint
CREATE INDEX `users_onboarded_idx` ON `users` (`onboarding_completed_at`);--> statement-breakpoint
CREATE INDEX `users_byo_keys_idx` ON `users` (`id`) WHERE byo_anthropic_key IS NOT NULL OR byo_deepgram_key IS NOT NULL OR byo_openrouter_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `meetings_status_updated_idx` ON `meetings` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `meetings_created_idx` ON `meetings` (`created_at`);--> statement-breakpoint
CREATE INDEX `meetings_started_idx` ON `meetings` (`started_at`);--> statement-breakpoint
CREATE INDEX `meetings_user_created_idx` ON `meetings` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `meetings_deleted_idx` ON `meetings` (`deleted_at`) WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX `dictations_deleted_idx` ON `dictations` (`deleted_at`) WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX `captures_deleted_idx` ON `captures` (`deleted_at`) WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX `devices_created_idx` ON `devices` (`created_at`);--> statement-breakpoint
-- (status) is a prefix of meetings_status_updated_idx, which serves every status filter it did.
DROP INDEX IF EXISTS `meetings_status_idx`;
