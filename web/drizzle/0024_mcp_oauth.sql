CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`scopes_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `oauth_codes_expires_idx` ON `oauth_codes` (`expires_at`);--> statement-breakpoint
ALTER TABLE `mcp_tokens` ADD `client_id` text;--> statement-breakpoint
ALTER TABLE `mcp_tokens` ADD `refresh_hash` text;--> statement-breakpoint
ALTER TABLE `mcp_tokens` ADD `refresh_expires_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tokens_refresh_hash_uq` ON `mcp_tokens` (`refresh_hash`);
