ALTER TABLE `mcp_tokens` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `mcp_tokens` ADD `path_auth_used_at` integer;--> statement-breakpoint
-- Existing tokens get the full 90 days from this migration, not from creation.
UPDATE `mcp_tokens` SET `expires_at` = CAST(strftime('%s', 'now') AS integer) * 1000 + 7776000000 WHERE `expires_at` IS NULL;
