CREATE TABLE `product_metrics_daily` (
	`date` text PRIMARY KEY NOT NULL,
	`signups` integer DEFAULT 0 NOT NULL,
	`onboarded_users` integer DEFAULT 0 NOT NULL,
	`paired_devices` integer DEFAULT 0 NOT NULL,
	`users_first_recording` integer DEFAULT 0 NOT NULL,
	`users_first_transcript` integer DEFAULT 0 NOT NULL,
	`meetings_started` integer DEFAULT 0 NOT NULL,
	`meetings_completed` integer DEFAULT 0 NOT NULL,
	`meetings_failed` integer DEFAULT 0 NOT NULL,
	`meetings_stuck` integer DEFAULT 0 NOT NULL,
	`audio_seconds` integer DEFAULT 0 NOT NULL,
	`estimated_ai_cost_microusd` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
