import { validateModelResult } from "./result-validator";

const KZ_ACCENT_URL = process.env.KZ_ACCENT_URL ?? "http://127.0.0.1:8766";

export type KzAccentResult = {
  result: string;
  model: string;
};

export async function normalizeWithKzAccent(
  value: string,
): Promise<KzAccentResult | null> {
  try {
    const response = await fetch(`${KZ_ACCENT_URL}/accent`, {
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
        typeof payload.model === "string"
          ? payload.model
          : "kz-accent-gold-v1-full",
    };
  } catch {
    return null;
  }
}
