const EXCEL_ERRORS = new Set([
  "#name?",
  "#value!",
  "#n/a",
  "#ref!",
  "#div/0!",
  "#num!",
  "#null!",
]);

export type PreparedInput =
  | { kind: "unknown"; result: "UNKNOWN" }
  | { kind: "processable"; value: string };

export function normalizeInput(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function prepareInput(value: string): PreparedInput {
  const normalized = normalizeInput(value);

  if (!normalized) {
    return { kind: "unknown", result: "UNKNOWN" };
  }

  if (EXCEL_ERRORS.has(normalized)) {
    return { kind: "unknown", result: "UNKNOWN" };
  }

  if (!/\p{L}/u.test(normalized)) {
    return { kind: "unknown", result: "UNKNOWN" };
  }

  return { kind: "processable", value: normalized };
}
