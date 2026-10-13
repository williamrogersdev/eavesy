ALTER TABLE `product_metrics_daily` ADD `users_first_return_7d` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `product_metrics_daily` ADD `processing_samples` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `product_metrics_daily` ADD `processing_ms_total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `product_metrics_daily` ADD `processing_ms_max` integer DEFAULT 0 NOT NULL;