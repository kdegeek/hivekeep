CREATE TABLE `feedback_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`dismissed` integer DEFAULT false NOT NULL,
	`snoozed_until` integer,
	`starred_at` integer,
	`last_prompt_at` integer,
	`submit_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
