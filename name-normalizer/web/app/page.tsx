"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import BatchReview from "./batch-review";
import { getNormalizeEndpoint } from "../lib/client-normalize-endpoint";

const MAX_INPUT_LENGTH = 120;

type HistoryRecord = {
  id: number;
  input: string;
  result: string;
  source: "local" | "openai";
  model: string | null;
  created_at: string;
};

export default function Home() {
  const [value, setValue] = useState("");
  const [acceptedInput, setAcceptedInput] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [copied, setCopied] = useState(false);

  const normalizedPreview = useMemo(
    () => value.normalize("NFC").trim().replace(/\s+/g, " "),
    [value],
  );

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/history", { cache: "no-store" });
      const payload = (await response.json()) as {
        records?: HistoryRecord[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Ошибка журнала");
      setHistory(payload.records ?? []);
      setHistoryError("");
    } catch (loadError) {
      setHistoryError(
        loadError instanceof Error ? loadError.message : "Ошибка журнала",
      );
    }
  }, []);

  useEffect(() => {
    // History is loaded from the external local D1 store after the first paint.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadHistory();
  }, [loadHistory]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedPreview || isLoading) return;

    setAcceptedInput(normalizedPreview);
    setResult("");
    setError("");
    setCopied(false);
    setIsLoading(true);

    try {
      const response = await fetch(getNormalizeEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: normalizedPreview, recordHistory: false }),
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
        throw new Error(payload.error || "Не удалось обработать строку");
      }

      setResult(payload.result);
      const baseInput = normalizedPreview.toLowerCase();
      const baseResult = payload.result.replaceAll("+", "").toLowerCase();
      const spellingChanged =
        payload.result !== "UNKNOWN" && baseInput !== baseResult;
      const bucket =
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

      const batchResponse = await fetch("/api/review-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          append: true,
          items: [
            {
              sourceValue: normalizedPreview,
              suggestedValue: payload.result,
              finalValue: payload.result === "UNKNOWN" ? null : payload.result,
              bucket,
              reason,
              model: payload.model ?? null,
              edited: false,
            },
          ],
        }),
      });
      if (!batchResponse.ok) {
        throw new Error("Результат получен, но не удалось добавить его в пачку");
      }
      window.dispatchEvent(new Event("review-batch-updated"));
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Не удалось обработать строку",
      );
    } finally {
      setIsLoading(false);
    }
  }

  function clearForm() {
    setValue("");
    setAcceptedInput("");
    setResult("");
    setError("");
    setCopied(false);
  }

  async function copyResult() {
    if (!result) return;
    await navigator.clipboard.writeText(result);
    setCopied(true);
  }

  async function clearHistory() {
    if (!window.confirm("Очистить весь локальный журнал результатов?")) return;
    const response = await fetch("/api/history", { method: "DELETE" });
    if (response.ok) {
      setHistory([]);
      setHistoryError("");
    } else {
      setHistoryError("Не удалось очистить локальный журнал");
    }
  }

  return (
    <main className="app-shell">
      <section className="workspace" aria-labelledby="page-title">
        <header className="hero">
          <div className="brand-mark" aria-hidden="true">+</div>
          <div>
            <p className="eyebrow">Локальный прототип</p>
            <h1 id="page-title">Нормализация имени</h1>
            <p className="hero-copy">
              Введите одну строку: имя, фамилию или отчество. Система исправит
              очевидные ошибки и поставит знак ударения перед ударной гласной.
            </p>
          </div>
        </header>

        <div className="content-grid">
          <form className="input-card" onSubmit={handleSubmit}>
            <div className="field-heading">
              <label htmlFor="name-input">Исходная строка</label>
              <span>{value.length}/{MAX_INPUT_LENGTH}</span>
            </div>
            <input
              id="name-input"
              name="name"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              maxLength={MAX_INPUT_LENGTH}
              placeholder="Например: жанаткалиева"
              autoComplete="off"
            />
            <p className="field-hint">
              Полное ФИО не требуется — обрабатывается только одна его часть.
            </p>
            <div className="actions">
              <button
                className="primary-action"
                disabled={!normalizedPreview || isLoading}
              >
                {isLoading ? "Обрабатываем…" : "Обработать"}
              </button>
              <button
                className="secondary-action"
                type="button"
                disabled={!value || isLoading}
                onClick={clearForm}
              >
                Очистить
              </button>
            </div>
          </form>

          <section className="result-card" aria-live="polite">
            <div className="result-heading">
              <span>Результат</span>
              <span className="status-pill">
                {isLoading ? "GPT обрабатывает" : "API подключён"}
              </span>
            </div>
            {error ? (
              <div className="accepted-state">
                <p className="error-value">Ошибка</p>
                <p className="pending-message">{error}</p>
              </div>
            ) : result ? (
              <div className="accepted-state">
                <p className="source-value">{result}</p>
                <p className="pending-message">Исходная строка: {acceptedInput}</p>
                <button className="copy-action" type="button" onClick={copyResult}>
                  {copied ? "Скопировано" : "Скопировать результат"}
                </button>
              </div>
            ) : (
              <div className="empty-state">
                <span aria-hidden="true">+</span>
                <p>Здесь появится обработанная строка</p>
              </div>
            )}
          </section>
        </div>

        <BatchReview />

        <section className="history-card" aria-labelledby="history-title">
          <div className="history-heading">
            <div>
              <p className="eyebrow">Только на этом компьютере</p>
              <h2 id="history-title">Журнал результатов</h2>
            </div>
            <button
              className="history-clear"
              type="button"
              disabled={history.length === 0}
              onClick={clearHistory}
            >
              Очистить журнал
            </button>
          </div>

          {historyError ? <p className="history-error">{historyError}</p> : null}
          {history.length === 0 ? (
            <p className="history-empty">Обработанные строки появятся здесь.</p>
          ) : (
            <div className="history-list">
              {history.map((record) => (
                <article className="history-row" key={record.id}>
                  <div className="history-values">
                    <span>{record.input}</span>
                    <span aria-hidden="true">→</span>
                    <strong>{record.result}</strong>
                  </div>
                  <div className="history-meta">
                    <span>
                      {record.source === "openai"
                        ? "GPT"
                        : record.model === "batch-delete"
                          ? "На удаление"
                        : record.model === "ruaccent-tiny"
                          ? "RUAccent"
                          : record.model === "kz-accent-gold-v1-full-rescued"
                            ? "KZ Accent v1 · спасено"
                          : record.model === "kz-accent-gold-v1-full"
                            ? "KZ Accent v1"
                          : "Локально"}
                    </span>
                    <time dateTime={record.created_at}>
                      {new Date(record.created_at).toLocaleString("ru-RU", {
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <footer className="stage-note">
          <p>Локальный интерфейс без подключения к рабочей базе данных</p>
        </footer>
      </section>
    </main>
  );
}
