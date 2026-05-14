CREATE TABLE `project_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`label` text NOT NULL,
	`color` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_project_tags_label` ON `project_tags` (`project_id`,`label`);--> statement-breakpoint
CREATE INDEX `idx_project_tags_project` ON `project_tags` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`github_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_projects_created` ON `projects` (`created_at`);--> statement-breakpoint
CREATE TABLE `ticket_tags` (
	`ticket_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`ticket_id`, `tag_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `project_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ticket_tags_ticket` ON `ticket_tags` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `idx_ticket_tags_tag` ON `ticket_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'backlog' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tickets_project_status_position` ON `tickets` (`project_id`,`status`,`position`);--> statement-breakpoint
CREATE INDEX `idx_tickets_project_updated` ON `tickets` (`project_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `kins` ADD `active_project_id` text REFERENCES projects(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `ticket_id` text REFERENCES tickets(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `idx_tasks_ticket` ON `tasks` (`ticket_id`);