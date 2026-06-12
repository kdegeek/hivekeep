ALTER TABLE `vault_secrets` ADD `last_used_at` integer;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `allowed_tools` text;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `allowed_hosts` text;