CREATE TABLE `workspace_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`path` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
