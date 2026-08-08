CREATE TABLE `recent_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`display_name` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`last_opened_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recent_files_path_idx` ON `recent_files` (`path`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `window_state` (
	`id` text PRIMARY KEY NOT NULL,
	`x` integer,
	`y` integer,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`maximized` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`open_tabs` text NOT NULL,
	`updated_at` integer NOT NULL
);
