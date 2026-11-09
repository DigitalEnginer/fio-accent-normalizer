import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const reviewBatches = sqliteTable("review_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status").notNull().default("reviewing"),
  total: integer("total").notNull(),
  createdAt: text("created_at").notNull(),
  approvedAt: text("approved_at"),
});

export const reviewBatchItems = sqliteTable("review_batch_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: integer("batch_id")
    .notNull()
    .references(() => reviewBatches.id),
  sortOrder: integer("sort_order").notNull(),
  externalRecordId: text("external_record_id"),
  sourceValue: text("source_value").notNull(),
  suggestedValue: text("suggested_value").notNull(),
  finalValue: text("final_value"),
  bucket: text("bucket").notNull(),
  reason: text("reason"),
  model: text("model"),
  edited: integer("edited", { mode: "boolean" }).notNull().default(false),
});
