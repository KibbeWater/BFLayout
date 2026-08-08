CREATE TABLE `snapshots` (
	`document_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`source` text NOT NULL,
	`document` text NOT NULL,
	`updated_at` integer NOT NULL
);
