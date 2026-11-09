import { env } from "cloudflare:workers";
import { ensureHistorySchema } from "./history";

export type ReviewBucket = "ready" | "attention" | "delete";
export type ReviewBatchStatus = "reviewing" | "approved";

export type ReviewBatchItem = {
  id: number;
  batch_id: number;
  sort_order: number;
  external_record_id: string | null;
  source_value: string;
  suggested_value: string;
  final_value: string | null;
  bucket: ReviewBucket;
  reason: string | null;
  model: string | null;
  edited: number;
};

export type ReviewBatch = {
  id: number;
  status: ReviewBatchStatus;
  total: number;
  created_at: string;
  approved_at: string | null;
  items: ReviewBatchItem[];
};

export type ReviewBatchItemDraft = {
  id?: number;
  externalRecordId?: string | null;
  sourceValue: string;
  suggestedValue: string;
  finalValue: string | null;
  bucket: ReviewBucket;
  reason?: string | null;
  model?: string | null;
  edited?: boolean;
};

const CREATE_BATCHES_TABLE = `
  CREATE TABLE IF NOT EXISTS review_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'reviewing' CHECK (status IN ('reviewing', 'approved')),
    total INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    approved_at TEXT
  )
`;

const CREATE_ITEMS_TABLE = `
  CREATE TABLE IF NOT EXISTS review_batch_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES review_batches(id),
    sort_order INTEGER NOT NULL,
    external_record_id TEXT,
    source_value TEXT NOT NULL,
    suggested_value TEXT NOT NULL,
    final_value TEXT,
    bucket TEXT NOT NULL CHECK (bucket IN ('ready', 'attention', 'delete')),
    reason TEXT,
    model TEXT,
    edited INTEGER NOT NULL DEFAULT 0
  )
`;

const CREATE_OPEN_BATCH_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_review_batches_status_id
  ON review_batches(status, id)
`;

function getDatabase(): D1Database {
  if (!env.DB) throw new Error("LOCAL_REVIEW_DATABASE_UNAVAILABLE");
  return env.DB;
}

async function ensureReviewSchema(): Promise<D1Database> {
  const database = getDatabase();
  await database.batch([
    database.prepare(CREATE_BATCHES_TABLE),
    database.prepare(CREATE_ITEMS_TABLE),
    database.prepare(CREATE_OPEN_BATCH_INDEX),
  ]);
  return database;
}

export async function getReviewBatch(id: number): Promise<ReviewBatch | null> {
  const database = await ensureReviewSchema();
  const batchResult = await database
    .prepare(
      `SELECT id, status, total, created_at, approved_at
       FROM review_batches WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .all<Omit<ReviewBatch, "items">>();
  const batch = batchResult.results?.[0];
  if (!batch) return null;

  const itemResult = await database
    .prepare(
      `SELECT id, batch_id, sort_order, external_record_id, source_value,
              suggested_value, final_value, bucket, reason, model, edited
       FROM review_batch_items
       WHERE batch_id = ?
       ORDER BY sort_order ASC`,
    )
    .bind(id)
    .all<ReviewBatchItem>();

  return { ...batch, items: itemResult.results ?? [] };
}

export async function getLatestReviewBatch(): Promise<ReviewBatch | null> {
  const database = await ensureReviewSchema();
  const result = await database
    .prepare(
      `SELECT id FROM review_batches
       WHERE status = 'reviewing'
       ORDER BY id DESC LIMIT 1`,
    )
    .all<{ id: number }>();
  const id = result.results?.[0]?.id;
  return typeof id === "number" ? getReviewBatch(id) : null;
}

export async function createReviewBatch(
  items: ReviewBatchItemDraft[],
): Promise<ReviewBatch> {
  const database = await ensureReviewSchema();
  const createdAt = new Date().toISOString();
  const inserted = await database
    .prepare(
      `INSERT INTO review_batches (status, total, created_at)
       VALUES ('reviewing', ?, ?)
       RETURNING id`,
    )
    .bind(items.length, createdAt)
    .all<{ id: number }>();
  const batchId = inserted.results?.[0]?.id;
  if (typeof batchId !== "number") throw new Error("BATCH_CREATE_FAILED");

  await database.batch(
    items.map((item, index) =>
      database
        .prepare(
          `INSERT INTO review_batch_items (
             batch_id, sort_order, external_record_id, source_value,
             suggested_value, final_value, bucket, reason, model, edited
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          batchId,
          index,
          item.externalRecordId ?? null,
          item.sourceValue,
          item.suggestedValue,
          item.bucket === "delete" ? null : item.finalValue,
          item.bucket,
          item.reason ?? null,
          item.model ?? null,
          item.edited ? 1 : 0,
        ),
    ),
  );

  const batch = await getReviewBatch(batchId);
  if (!batch) throw new Error("BATCH_READ_AFTER_CREATE_FAILED");
  return batch;
}

export async function appendToLatestReviewBatch(
  items: ReviewBatchItemDraft[],
): Promise<ReviewBatch> {
  const database = await ensureReviewSchema();
  const latest = await database
    .prepare(
      `SELECT id FROM review_batches
       WHERE status = 'reviewing'
       ORDER BY id DESC LIMIT 1`,
    )
    .all<{ id: number }>();
  const batchId = latest.results?.[0]?.id;
  if (typeof batchId !== "number") return createReviewBatch(items);

  const orderResult = await database
    .prepare(
      `SELECT COALESCE(MAX(sort_order), -1) AS max_order
       FROM review_batch_items WHERE batch_id = ?`,
    )
    .bind(batchId)
    .all<{ max_order: number }>();
  const firstOrder = (orderResult.results?.[0]?.max_order ?? -1) + 1;

  await database.batch([
    ...items.map((item, index) =>
      database
        .prepare(
          `INSERT INTO review_batch_items (
             batch_id, sort_order, external_record_id, source_value,
             suggested_value, final_value, bucket, reason, model, edited
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          batchId,
          firstOrder + index,
          item.externalRecordId ?? null,
          item.sourceValue,
          item.suggestedValue,
          item.bucket === "delete" ? null : item.finalValue,
          item.bucket,
          item.reason ?? null,
          item.model ?? null,
          item.edited ? 1 : 0,
        ),
    ),
    database
      .prepare("UPDATE review_batches SET total = total + ? WHERE id = ?")
      .bind(items.length, batchId),
  ]);

  const batch = await getReviewBatch(batchId);
  if (!batch) throw new Error("BATCH_READ_AFTER_APPEND_FAILED");
  return batch;
}

export async function updateReviewBatch(
  id: number,
  items: ReviewBatchItemDraft[],
  approve: boolean,
): Promise<ReviewBatch> {
  const database = await ensureReviewSchema();
  await database.batch(
    items.map((item) => {
      if (typeof item.id !== "number") throw new Error("ITEM_ID_REQUIRED");
      return database
        .prepare(
          `UPDATE review_batch_items
           SET final_value = ?, bucket = ?, reason = ?, edited = ?
           WHERE id = ? AND batch_id = ?`,
        )
        .bind(
          item.bucket === "delete" ? null : item.finalValue,
          item.bucket,
          item.reason ?? null,
          item.edited ? 1 : 0,
          item.id,
          id,
        );
    }),
  );

  if (approve) {
    await ensureHistorySchema();
    const approvedAt = new Date().toISOString();
    await database.batch([
      database
        .prepare(
          `INSERT INTO normalization_history (input, result, source, model)
           SELECT source_value,
                  CASE WHEN bucket = 'delete' THEN 'NULL' ELSE final_value END,
                  'local',
                  CASE WHEN bucket = 'delete' THEN 'batch-delete' ELSE model END
           FROM review_batch_items
           WHERE batch_id = ?
             AND EXISTS (
               SELECT 1 FROM review_batches
               WHERE id = ? AND status = 'reviewing'
             )
           ORDER BY sort_order ASC`,
        )
        .bind(id, id),
      database
        .prepare(
          `UPDATE review_batches
           SET status = 'approved', approved_at = ?
           WHERE id = ? AND status = 'reviewing'`,
        )
        .bind(approvedAt, id),
    ]);
  }

  const batch = await getReviewBatch(id);
  if (!batch) throw new Error("BATCH_NOT_FOUND");
  return batch;
}
