ALTER TABLE `meetings` ADD `first_transcript_at` integer;--> statement-breakpoint
ALTER TABLE `product_metrics_daily` ADD `first_transcript_samples` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `product_metrics_daily` ADD `first_transcript_ms_total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `product_metrics_daily` ADD `first_transcript_ms_max` integer DEFAULT 0 NOT NULL;