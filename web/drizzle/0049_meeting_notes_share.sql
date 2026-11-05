ALTER TABLE `email_deliveries` ADD `note` text;--> statement-breakpoint
ALTER TABLE `users` ADD `email_recaps_set_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `email_recaps_off_reason` text;--> statement-breakpoint
ALTER TABLE `users` ADD `email_recaps_auto_enabled_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `email_recaps_notice_pending` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `email_recaps_off_token` text;--> statement-breakpoint
ALTER TABLE `users` ADD `share_notes_offer` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `share_notes_scope` text DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `share_notes_auto` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `users_recaps_off_token_uq` ON `users` (`email_recaps_off_token`);--> statement-breakpoint
-- Recaps become on by default. Record why existing accounts have them off, so
-- the switch-on below (and any later one) leaves those accounts alone:
-- a spam complaint, or an account that got recaps before and has them off now,
-- which means its owner turned them off.
UPDATE `users` SET `email_recaps_off_reason` = 'complaint'
  WHERE `email_recaps` = 0
    AND `id` IN (SELECT `user_id` FROM `email_deliveries` WHERE `status` = 'complained');--> statement-breakpoint
UPDATE `users` SET `email_recaps_off_reason` = 'user'
  WHERE `email_recaps` = 0 AND `email_recaps_off_reason` IS NULL
    AND `id` IN (SELECT `user_id` FROM `email_deliveries` WHERE `kind` = 'meeting_recap');--> statement-breakpoint
-- Every other signed-in account with an address gets them on once, and its next
-- recap says so with a link to turn them off. Nothing is deleted.
UPDATE `users` SET
    `email_recaps` = 1,
    `email_recaps_auto_enabled_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
    `email_recaps_notice_pending` = 1
  WHERE `email_recaps` = 0 AND `email_recaps_off_reason` IS NULL
    AND `is_anonymous` = 0 AND `email` IS NOT NULL AND trim(`email`) <> '';
