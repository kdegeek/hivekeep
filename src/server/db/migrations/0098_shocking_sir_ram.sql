ALTER TABLE `quick_sessions` ADD `model` text;--> statement-breakpoint
ALTER TABLE `quick_sessions` ADD `provider_id` text REFERENCES providers(id);--> statement-breakpoint
ALTER TABLE `quick_sessions` ADD `thinking_enabled` integer;--> statement-breakpoint
ALTER TABLE `quick_sessions` ADD `thinking_effort` text;