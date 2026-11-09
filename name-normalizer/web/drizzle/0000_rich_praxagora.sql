CREATE TABLE `review_batch_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`sort_order` integer NOT NULL,
	`external_record_id` text,
	`source_value` text NOT NULL,
	`suggested_value` text NOT NULL,
	`final_value` text,
	`bucket` text NOT NULL,
	`reason` text,
	`model` text,
	`edited` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `review_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `review_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text DEFAULT 'reviewing' NOT NULL,
	`total` integer NOT NULL,
	`created_at` text NOT NULL,
	`approved_at` text
);
