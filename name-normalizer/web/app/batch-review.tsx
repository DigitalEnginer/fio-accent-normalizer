"use client";

import { useEffect, useMemo, useState } from "react";
import { getNormalizeEndpoint } from "../lib/client-normalize-endpoint";

type Bucket = "ready" | "attention" | "delete";
type BatchStatus = "reviewing" | "approved";

type BatchItem = {
  id?: number;
  sourceValue: string;
  suggestedValue: string;
  finalValue: string | null;
  bucket: Bucket;
  reason: string | null;
  model: string | null;
  edited: boolean;
};

type Batch = {
  id: number;
  status: BatchStatus;
  total: number;
  createdAt: string;
  approvedAt: string | null;
  items: BatchItem[];
};

type ApiBatch = {
  id: number;
  status: BatchStatus;
  total: number;
  created_at: string;
  approved_at: string | null;
  items: Array<{
    id: number;
    source_value: string;
    suggested_value: string;
    final_value: string | null;
    bucket: Bucket;
    reason: string | null;
    model: string | null;
    edited: number;
  }>;
};

const TAB_LABELS: Record<"all" | Bucket, string> = {
  all: "Все",
  ready: "Готовые",
  attention: "Требуют внимания",
  delete: "На удаление",
};

function mapBatch(batch: ApiBatch): Batch {
  return {
    id: batch.id,
    status: batch.status,
    total: batch.total,
    createdAt: batch.created_at,
    approvedAt: batch.approved_at,
    items: batch.items.map((item) => ({
      id: item.id,
      sourceValue: item.source_value,
      suggestedValue: item.suggested_value,
      finalValue: item.final_value,
      bucket: item.bucket,
      reason: item.reason,
      model: item.model,
      edited: item.edited === 1,
    })),
  };
}

function payloadItems(items: BatchItem[]) {
  return items.map((item) => ({
    id: item.id,
    sourceValue: item.sourceValue,
    suggestedValue: item.suggestedValue,
    finalValue: item.finalValue,
    bucket: item.bucket,
    reason: item.reason,
    model: item.model,
    edited: item.edited,
  }));
}

function baseValue(value: string): string {
  return value.normalize("NFC").trim().toLowerCase().replaceAll("+", "");
}

export default function BatchReview() {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [bulkInput, setBulkInput] = useState("");
  const [activeTab, setActiveTab] = useState<"all" | Bucket>("all");
  const [isProcessing, setIsProcessing] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");
  const [invalidItemId, setInvalidItemId] = useState<number | null>(null);

  useEffect(() => {
    async function loadCurrentBatch() {
      try {
        const response = await fetch("/api/review-batches", { cache: "no-store" });
        const payload = (await response.json()) as { batch?: ApiBatch | null };
        if (response.ok && payload.batch) setBatch(mapBatch(payload.batch));
      } catch {
        // The batch surface can still be used to create a fresh local batch.
      }
    }

    void loadCurrentBatch();
    window.addEventListener("review-batch-updated", loadCurrentBatch);
    return () => {
      window.removeEventListener("review-batch-updated", loadCurrentBatch);
    };
  }, []);

  useEffect(() => {
    if (invalidItemId === null) return;
    const frame = window.requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-batch-item-id="${invalidItemId}"]`,
      );
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
      const input = row?.querySelector<HTMLInputElement>("input");
      input?.focus({ preventScroll: true });
      input?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, invalidItemId]);

  const counts = useMemo(() => {
    const items = batch?.items ?? [];
    return {
      all: items.length,
      ready: items.filter((item) => item.bucket === "ready").length,
      attention: items.filter((item) => item.bucket === "attention").length,
      delete: items.filter((item) => item.bucket === "delete").length,
    };
  }, [batch]);

  const visibleItems = useMemo(
    () =>
      (batch?.items ?? []).filter(
        (item) => activeTab === "all" || item.bucket === activeTab,
      ),
    [activeTab, batch],
  );

  async function persist(items: BatchItem[], approve = false) {
    if (!batch) return false;
    setSaveState("saving");
    setError("");
    try {
      const response = await fetch("/api/review-batches", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: batch.id,
          items: payloadItems(items),
          approve,
        }),
      });
      const payload = (await response.json()) as {
        batch?: ApiBatch;
        error?: string;
        invalidItemId?: number | null;
      };
      if (!response.ok || !payload.batch) {
        if (typeof payload.invalidItemId === "number") {
          const invalidItem = items.find(
            (item) => item.id === payload.invalidItemId,
          );
          setInvalidItemId(payload.invalidItemId);
          setActiveTab(invalidItem?.bucket ?? "all");
        }
        throw new Error(payload.error || "Не удалось сохранить пачку");
      }
      setBatch(mapBatch(payload.batch));
      setInvalidItemId(null);
      setSaveState("saved");
      return true;
    } catch (saveError) {
      setSaveState("idle");
      setError(
        saveError instanceof Error ? saveError.message : "Не удалось сохранить пачку",
      );
      return false;
    }
  }

  async function processBatch() {
    const values = bulkInput
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length === 0 || isProcessing) return;
    if (values.length > 200) {
      setError("В одной локальной пачке допускается не больше 200 строк");
      return;
    }

    setIsProcessing(true);
    setError("");
    const processed: BatchItem[] = new Array(values.length);
    let cursor = 0;

    async function worker() {
      while (cursor < values.length) {
        const index = cursor++;
        const sourceValue = values[index];
        try {
          const response = await fetch(getNormalizeEndpoint(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: sourceValue, recordHistory: false }),
          });
          const payload = (await response.json()) as {
            result?: string;
            model?: string;
            rescuedFromUnknown?: boolean;
            requiresAttention?: boolean;
            attentionReason?: string | null;
            error?: string;
          };
          if (!response.ok || !payload.result) {
            throw new Error(payload.error || "Ошибка обработки");
          }

          const spellingChanged =
            payload.result !== "UNKNOWN" &&
            baseValue(payload.result) !== baseValue(sourceValue);
          const bucket: Bucket =
            payload.result === "UNKNOWN"
              ? "delete"
              : payload.requiresAttention || payload.rescuedFromUnknown || spellingChanged
                ? "attention"
                : "ready";
          const reason =
            payload.result === "UNKNOWN"
              ? "Кандидат на NULL: система не распознала имя"
              : payload.attentionReason
                ? payload.attentionReason
              : payload.rescuedFromUnknown
                ? "Спасено после UNKNOWN"
                : spellingChanged
                  ? "Изменено написание или выполнена транслитерация"
                  : null;

          processed[index] = {
            sourceValue,
            suggestedValue: payload.result,
            finalValue: payload.result === "UNKNOWN" ? null : payload.result,
            bucket,
            reason,
            model: payload.model ?? null,
            edited: false,
          };
        } catch (requestError) {
          processed[index] = {
            sourceValue,
            suggestedValue: "",
            finalValue: "",
            bucket: "attention",
            reason:
              requestError instanceof Error
                ? requestError.message
                : "Ошибка обработки",
            model: null,
            edited: false,
          };
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(3, values.length) }, worker));

    try {
      const response = await fetch("/api/review-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: payloadItems(processed) }),
      });
      const payload = (await response.json()) as {
        batch?: ApiBatch;
        error?: string;
      };
      if (!response.ok || !payload.batch) {
        throw new Error(payload.error || "Не удалось создать пачку");
      }
      const created = mapBatch(payload.batch);
      setBatch(created);
      setBulkInput("");
      setActiveTab(
        created.items.some((item) => item.bucket === "attention")
          ? "attention"
          : "all",
      );
      setSaveState("saved");
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : "Не удалось создать пачку",
      );
    } finally {
      setIsProcessing(false);
    }
  }

  function updateItem(id: number | undefined, patch: Partial<BatchItem>) {
    if (!batch) return;
    setBatch({
      ...batch,
      items: batch.items.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    });
    setSaveState("idle");
  }

  async function changeBucket(item: BatchItem, bucket: Bucket) {
    if (!batch) return;
    const nextItems = batch.items.map((candidate) =>
      candidate.id === item.id
        ? {
            ...candidate,
            bucket,
            finalValue:
              bucket === "delete"
                ? null
                : candidate.finalValue || candidate.suggestedValue.replaceAll("UNKNOWN", ""),
            reason:
              bucket === "delete"
                ? "Отмечено оператором для записи NULL"
                : "Возвращено оператором на проверку",
            edited: true,
          }
        : candidate,
    );
    setBatch({ ...batch, items: nextItems });
    await persist(nextItems);
  }

  async function approveBatch() {
    if (!batch || batch.status === "approved") return;
    const confirmed = window.confirm(
      `Подтвердить всю пачку?\n\n${counts.all - counts.delete} значений будут подготовлены к записи, ${counts.delete} — к записи NULL.`,
    );
    if (!confirmed) return;
    await persist(batch.items, true);
  }

  if (!batch) {
    return (
      <section className="batch-card" aria-labelledby="batch-title">
        <div className="batch-heading">
          <div>
            <p className="eyebrow">Пакетная обработка</p>
            <h2 id="batch-title">Новая пачка имён</h2>
          </div>
          <span className="batch-badge">Локальная очередь</span>
        </div>
        <p className="batch-description">
          Вставьте исходные значения — каждое с новой строки. Для прототипа это
          заменяет получение записей из рабочей БД. В журнал они попадут только
          после подтверждения всей пачки.
        </p>
        <textarea
          className="batch-textarea"
          value={bulkInput}
          onChange={(event) => setBulkInput(event.target.value)}
          placeholder={"бешкемпір\nпокрава\nабдикериова"}
          rows={7}
        />
        {error ? <p className="batch-error">{error}</p> : null}
        <button
          className="primary-action batch-process"
          type="button"
          disabled={!bulkInput.trim() || isProcessing}
          onClick={() => void processBatch()}
        >
          {isProcessing ? "Обрабатываем пачку…" : "Обработать пачку"}
        </button>
      </section>
    );
  }

  return (
    <section className="batch-card" aria-labelledby="batch-title">
      <div className="batch-heading">
        <div>
          <p className="eyebrow">Пачка №{batch.id}</p>
          <h2 id="batch-title">
            {batch.status === "approved" ? "Пачка подтверждена" : "Проверка результатов"}
          </h2>
        </div>
        <div className="batch-save-state">
          {batch.status === "approved"
            ? "Готово к передаче в БД"
            : saveState === "saving"
              ? "Сохраняем…"
              : saveState === "saved"
                ? "Черновик сохранён"
                : "Есть изменения"}
        </div>
      </div>

      <div className="batch-summary" aria-label="Сводка пачки">
        <span><strong>{counts.all}</strong> всего</span>
        <span><strong>{counts.ready}</strong> готовы</span>
        <span className="summary-attention"><strong>{counts.attention}</strong> проверить</span>
        <span className="summary-delete"><strong>{counts.delete}</strong> на удаление</span>
      </div>

      <div className="batch-tabs" role="tablist" aria-label="Фильтр строк">
        {(Object.keys(TAB_LABELS) as Array<"all" | Bucket>).map((tab) => (
          <button
            key={tab}
            type="button"
            className={activeTab === tab ? "batch-tab active" : "batch-tab"}
            onClick={() => setActiveTab(tab)}
          >
            {TAB_LABELS[tab]} <span>{counts[tab]}</span>
          </button>
        ))}
      </div>

      <div className="batch-table-wrap">
        <table className="batch-table">
          <thead>
            <tr>
              <th>Исходное значение</th>
              <th>Результат</th>
              <th>Статус</th>
              <th><span className="sr-only">Действия</span></th>
            </tr>
          </thead>
          <tbody>
            {visibleItems.map((item) => (
              <tr
                key={item.id}
                data-batch-item-id={item.id}
                className={`batch-row ${item.bucket}${item.id === invalidItemId ? " invalid" : ""}`}
              >
                <td className="batch-source">{item.sourceValue}</td>
                <td>
                  {item.bucket === "delete" ? (
                    <div className="null-value">NULL</div>
                  ) : (
                    <input
                      className="review-result-input"
                      value={item.finalValue ?? ""}
                      disabled={batch.status === "approved"}
                      aria-label={`Результат для ${item.sourceValue}`}
                      onChange={(event) =>
                        updateItem(item.id, {
                          finalValue: event.target.value,
                          edited: event.target.value !== item.suggestedValue,
                        })
                      }
                      onBlur={() => void persist(batch.items)}
                    />
                  )}
                  {item.id === invalidItemId ? (
                    <p className="row-validation-error">
                      Исправьте результат этой строки перед подтверждением пачки
                    </p>
                  ) : null}
                  {item.reason ? <p className="row-reason">{item.reason}</p> : null}
                </td>
                <td>
                  <span className={`row-status ${item.bucket}`}>
                    {item.bucket === "ready"
                      ? item.edited ? "Исправлено" : "Готово"
                      : item.bucket === "attention"
                        ? item.edited ? "Исправлено" : "Проверить"
                        : "Записать NULL"}
                  </span>
                </td>
                <td>
                  {batch.status === "reviewing" ? (
                    <div className="row-actions">
                      {item.bucket !== "ready" ? (
                        <button type="button" onClick={() => void changeBucket(item, "ready")}>
                          В готовые
                        </button>
                      ) : (
                        <button type="button" onClick={() => void changeBucket(item, "attention")}>
                          Проверить
                        </button>
                      )}
                      {item.bucket !== "delete" ? (
                        <button className="delete-action" type="button" onClick={() => void changeBucket(item, "delete")}>
                          В удаление
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error ? <p className="batch-error">{error}</p> : null}
      <div className="batch-footer">
        <p>
          Удаление применяется только к строкам в разделе «На удаление».
          После подтверждения вся пачка перейдёт в локальный журнал.
        </p>
        {batch.status === "reviewing" ? (
          <button className="primary-action approve-batch" type="button" onClick={() => void approveBatch()}>
            Подтвердить всю пачку
          </button>
        ) : (
          <button className="secondary-action" type="button" onClick={() => { setBatch(null); setActiveTab("all"); }}>
            Создать новую пачку
          </button>
        )}
      </div>
    </section>
  );
}
