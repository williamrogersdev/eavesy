CREATE TABLE `ai_credit_budgets` (
	`scope` text PRIMARY KEY NOT NULL,
	`reserved_microusd` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_credit_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`model` text NOT NULL,
	`purpose` text NOT NULL,
	`reserved_microusd` integer NOT NULL,
	`estimated_microusd` integer,
	`input_units` integer,
	`output_tokens` integer,
	`pricing_version` text DEFAULT '2026-10-20' NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `ai_credit_usage_created_idx` ON `ai_credit_usage` (`created_at`);