CREATE TABLE `snapshots` (
	`key` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`document` text NOT NULL,
	`updated_at` integer NOT NULL
);
