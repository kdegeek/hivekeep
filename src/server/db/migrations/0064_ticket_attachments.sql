CREATE TABLE `ticket_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`original_name` text NOT NULL,
	`stored_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`description` text,
	`uploaded_by_user_id` text,
	`uploaded_by_kin_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`uploaded_by_kin_id`) REFERENCES `kins`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_ticket_attachments_ticket` ON `ticket_attachments` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `idx_ticket_attachments_ticket_created` ON `ticket_attachments` (`ticket_id`,`created_at`);