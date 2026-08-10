CREATE TABLE `index_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`relative_path` text NOT NULL,
	`entry_name` text,
	`format` text NOT NULL,
	`size` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `index_files_run_idx` ON `index_files` (`run_id`,`relative_path`);--> statement-breakpoint
CREATE TABLE `index_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`root_path` text NOT NULL,
	`built_at` integer NOT NULL,
	`file_count` integer NOT NULL,
	`symbol_count` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_runs_root_idx` ON `index_runs` (`root_path`);--> statement-breakpoint
CREATE TABLE `index_symbols` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `index_symbols_name_idx` ON `index_symbols` (`name`);--> statement-breakpoint
CREATE INDEX `index_symbols_file_idx` ON `index_symbols` (`file_id`);