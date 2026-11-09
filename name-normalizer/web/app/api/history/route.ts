import {
  clearHistoryRecords,
  listHistoryRecords,
} from "../../../db/history";

export async function GET(): Promise<Response> {
  try {
    const records = await listHistoryRecords();
    return Response.json({ records });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    return Response.json(
      { error: "Не удалось загрузить локальный журнал", detail },
      { status: 500 },
    );
  }
}

export async function DELETE(): Promise<Response> {
  try {
    await clearHistoryRecords();
    return Response.json({ success: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    return Response.json(
      { error: "Не удалось очистить локальный журнал", detail },
      { status: 500 },
    );
  }
}
