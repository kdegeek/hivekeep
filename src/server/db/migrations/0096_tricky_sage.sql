CREATE TABLE `model_registry` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`display_name` text,
	`mapping_mode` text DEFAULT 'auto' NOT NULL,
	`models_dev_key` text,
	`match_confidence` text,
	`context_window` integer,
	`max_output` integer,
	`supports_tool_call` integer,
	`supports_image_input` integer,
	`supports_pdf_input` integer,
	`reasoning` text,
	`pricing` text,
	`overridden_fields` text,
	`enabled` integer DEFAULT true NOT NULL,
	`needs_review` integer DEFAULT false NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_model_registry_provider_model` ON `model_registry` (`provider_id`,`model_id`);--> statement-breakpoint
CREATE INDEX `idx_model_registry_provider` ON `model_registry` (`provider_id`);