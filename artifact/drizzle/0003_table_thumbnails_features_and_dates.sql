ALTER TABLE `tables` ADD COLUMN `features_json` text;
--> statement-breakpoint
ALTER TABLE `tables` ADD COLUMN `last_played_at` integer;
--> statement-breakpoint
ALTER TABLE `tables` ADD COLUMN `added_at` integer;
--> statement-breakpoint
ALTER TABLE `tables` ADD COLUMN `thumb_blob_key` text;
--> statement-breakpoint
ALTER TABLE `tables` ADD COLUMN `thumb_fetched_at` integer;
--> statement-breakpoint
ALTER TABLE `bridge_sync` ADD COLUMN `thumb_attempt_at` integer;
