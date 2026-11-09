import { env } from "cloudflare:workers";

export type HistoryRecord = {
  id: number;
  input: string;
  result: string;
  source: "local" | "openai";
  model: string | null;
  created_at: string;
};

const CREATE_HISTORY_TABLE = `
  CREATE TABLE IF NOT EXISTS normalization_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    input TEXT NOT NULL,
    result TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('local', 'openai')),
    model TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`;

function getDatabase(): D1Database {
  if (!env.DB) throw new Error("LOCAL_HISTORY_DATABASE_UNAVAILABLE");
  return env.DB;
}

export async function ensureHistorySchema(): Promise<D1Database> {
  const database = getDatabase();
  await database.prepare(CREATE_HISTORY_TABLE).run();
  return database;
}

export async function saveHistoryRecord(record: {
  input: string;
  result: string;
  source: "local" | "openai";
  model?: string | null;
}): Promise<void> {
  const database = await ensureHistorySchema();
  await database
    .prepare(
      `INSERT INTO normalization_history (input, result, source, model)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(record.input, record.result, record.source, record.model ?? null)
    .run();
}

export async function listHistoryRecords(limit = 50): Promise<HistoryRecord[]> {
  const database = await ensureHistorySchema();
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const response = await database
    .prepare(
      `SELECT id, input, result, source, model, created_at
       FROM normalization_history
       ORDER BY id DESC
       LIMIT ?`,
    )
    .bind(safeLimit)
    .all<HistoryRecord>();

  return response.results ?? [];
}

export async function clearHistoryRecords(): Promise<void> {
  const database = await ensureHistorySchema();
  await database.prepare("DELETE FROM normalization_history").run();
}
