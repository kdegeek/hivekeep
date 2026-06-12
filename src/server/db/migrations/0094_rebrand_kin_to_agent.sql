-- Rebrand: rename the Kin concept -> Agent (tables + columns).
-- SQLite auto-cascades these renames to FKs, indexes, triggers and views.
ALTER TABLE `compacting_snapshots` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `crons` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `crons` RENAME COLUMN `target_kin_id` TO `target_agent_id`;--> statement-breakpoint
ALTER TABLE `files` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `kin_mcp_servers` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `memories` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `queue_items` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `tasks` RENAME COLUMN `parent_kin_id` TO `parent_agent_id`;--> statement-breakpoint
ALTER TABLE `tasks` RENAME COLUMN `source_kin_id` TO `source_agent_id`;--> statement-breakpoint
ALTER TABLE `tasks` RENAME COLUMN `inter_kin_request_count` TO `inter_agent_request_count`;--> statement-breakpoint
ALTER TABLE `user_profiles` RENAME COLUMN `kin_order` TO `agent_order`;--> statement-breakpoint
ALTER TABLE `vault_secrets` RENAME COLUMN `created_by_kin_id` TO `created_by_agent_id`;--> statement-breakpoint
ALTER TABLE `file_storage` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `file_storage` RENAME COLUMN `created_by_kin_id` TO `created_by_agent_id`;--> statement-breakpoint
ALTER TABLE `human_prompts` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `webhooks` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `channels` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `invitations` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `notifications` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `scheduled_wakeups` RENAME COLUMN `caller_kin_id` TO `caller_agent_id`;--> statement-breakpoint
ALTER TABLE `scheduled_wakeups` RENAME COLUMN `target_kin_id` TO `target_agent_id`;--> statement-breakpoint
ALTER TABLE `mcp_servers` RENAME COLUMN `created_by_kin_id` TO `created_by_agent_id`;--> statement-breakpoint
ALTER TABLE `vault_types` RENAME COLUMN `created_by_kin_id` TO `created_by_agent_id`;--> statement-breakpoint
ALTER TABLE `mini_apps` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `quick_sessions` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `knowledge_chunks` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `knowledge_sources` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `compacting_summaries` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `llm_usage` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `kin_read_state` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `contact_notes` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `tickets` RENAME COLUMN `reporter_kin_id` TO `reporter_agent_id`;--> statement-breakpoint
ALTER TABLE `ticket_comments` RENAME COLUMN `author_kin_id` TO `author_agent_id`;--> statement-breakpoint
ALTER TABLE `ticket_attachments` RENAME COLUMN `uploaded_by_kin_id` TO `uploaded_by_agent_id`;--> statement-breakpoint
ALTER TABLE `project_knowledge` RENAME COLUMN `author_kin_id` TO `author_agent_id`;--> statement-breakpoint
ALTER TABLE `pending_email_sends` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `channel_message_links` RENAME COLUMN `sent_by_kin_id` TO `sent_by_agent_id`;--> statement-breakpoint
ALTER TABLE `secret_prompts` RENAME COLUMN `kin_id` TO `agent_id`;--> statement-breakpoint
ALTER TABLE `kin_mcp_servers` RENAME TO `agent_mcp_servers`;--> statement-breakpoint
ALTER TABLE `kins` RENAME TO `agents`;--> statement-breakpoint
ALTER TABLE `kin_read_state` RENAME TO `agent_read_state`;
