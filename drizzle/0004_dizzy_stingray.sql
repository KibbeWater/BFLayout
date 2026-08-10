CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`dump_path` text NOT NULL,
	`mod_path` text NOT NULL,
	`title_id` text DEFAULT '' NOT NULL,
	`game_version` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_mod_path_idx` ON `projects` (`mod_path`);