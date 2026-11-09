import { validateModelResult } from "./result-validator";

const RUACCENT_URL = process.env.RUACCENT_URL ?? "http://127.0.0.1:8765";

export type RuAccentResult = {
  result: string;
  model: string;
};

export async function normalizeWithRuAccent(
  value: string,
): Promise<RuAccentResult | null> {
  try {
    const response = await fetch(`${RUACCENT_URL}/accent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) return null;
    const payload = (await response.json()) as {
      result?: unknown;
      model?: unknown;
    };
    if (typeof payload.result !== "string") return null;

    const validated = validateModelResult(payload.result);
    if (!validated.valid || validated.value === "UNKNOWN") return null;

    return {
      result: validated.value,
      model:
        typeof payload.model === "string" ? payload.model : "ruaccent-tiny",
    };
  } catch {
    return null;
  }
}
