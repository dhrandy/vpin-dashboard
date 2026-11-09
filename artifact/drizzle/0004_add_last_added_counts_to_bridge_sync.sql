ALTER TABLE `bridge_sync` ADD COLUMN `last_added_tables` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `bridge_sync` ADD COLUMN `last_added_scores` integer DEFAULT 0 NOT NULL;
