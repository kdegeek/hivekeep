CREATE TABLE `terminal_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`backend` text DEFAULT 'pty' NOT NULL,
	`tmux_name` text,
	`last_cwd` text,
	`scrollback` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_terminal_sessions_user` ON `terminal_sessions` (`user_id`);