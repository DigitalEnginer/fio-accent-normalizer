import {
  appendToLatestReviewBatch,
  createReviewBatch,
  getLatestReviewBatch,
  updateReviewBatch,
  type ReviewBatchItemDraft,
  type ReviewBucket,
} from "../../../db/review-batches";
import { validateModelResult } from "../../../lib/result-validator";

const BUCKETS = new Set<ReviewBucket>(["ready", "attention", "delete"]);
const MAX_CREATE_ITEMS = 200;
const MAX_REVIEW_ITEMS = 2_000;

function parseItems(
  value: unknown,
  maxItems: number,
): ReviewBatchItemDraft[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    return null;
  }

  const items: ReviewBatchItemDraft[] = [];
  for (const rawItem of value) {
    if (typeof rawItem !== "object" || rawItem === null) return null;
    const item = rawItem as Record<string, unknown>;
    if (
      typeof item.sourceValue !== "string" ||
      typeof item.suggestedValue !== "string" ||
      (typeof item.finalValue !== "string" && item.finalValue !== null) ||
      typeof item.bucket !== "string" ||
      !BUCKETS.has(item.bucket as ReviewBucket)
    ) {
      return null;
    }
    items.push({
      id: typeof item.id === "number" ? item.id : undefined,
      externalRecordId:
        typeof item.externalRecordId === "string" ? item.externalRecordId : null,
      sourceValue: item.sourceValue,
      suggestedValue: item.suggestedValue,
      finalValue: item.finalValue,
      bucket: item.bucket as ReviewBucket,
      reason: typeof item.reason === "string" ? item.reason : null,
      model: typeof item.model === "string" ? item.model : null,
      edited: item.edited === true,
    });
  }
  return items;
}

export async function GET(): Promise<Response> {
  try {
    return Response.json({ batch: await getLatestReviewBatch() });
  } catch (error) {
    return Response.json(
      {
        error: "Не удалось загрузить текущую пачку",
        detail: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { items?: unknown; append?: unknown };
    const items = parseItems(body.items, MAX_CREATE_ITEMS);
    if (!items) {
      return Response.json(
        { error: "Ожидается от 1 до 200 обработанных строк" },
        { status: 400 },
      );
    }
    return Response.json({
      batch:
        body.append === true
          ? await appendToLatestReviewBatch(items)
          : await createReviewBatch(items),
    });
  } catch (error) {
    return Response.json(
      {
        error: "Не удалось создать пачку",
        detail: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as {
      id?: unknown;
      items?: unknown;
      approve?: unknown;
    };
    const items = parseItems(body.items, MAX_REVIEW_ITEMS);
    if (typeof body.id !== "number" || !items) {
      return Response.json({ error: "Некорректная пачка" }, { status: 400 });
    }

    const approve = body.approve === true;
    if (approve) {
      for (const item of items) {
        if (item.bucket === "delete") continue;
        const validation = validateModelResult(item.finalValue ?? "");
        if (!validation.valid || validation.value === "UNKNOWN") {
          return Response.json(
            {
              error: `Проверьте результат для строки «${item.sourceValue}»`,
              invalidItemId: item.id ?? null,
            },
            { status: 400 },
          );
        }
      }
    }

    return Response.json({
      batch: await updateReviewBatch(body.id, items, approve),
    });
  } catch (error) {
    return Response.json(
      {
        error: "Не удалось сохранить пачку",
        detail: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}
