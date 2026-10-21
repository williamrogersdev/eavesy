ALTER TABLE `users` ADD `dictation_style` text;--> statement-breakpoint
ALTER TABLE `users` ADD `dictation_for_agents` integer DEFAULT false NOT NULL;
