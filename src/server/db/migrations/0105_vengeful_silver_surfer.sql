CREATE TABLE `channel_pending_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`mapping_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mapping_id`) REFERENCES `channel_user_mappings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_channel_pending_msg_mapping` ON `channel_pending_messages` (`mapping_id`);