import { decideLocally } from "../../../lib/local-pipeline";
import { normalizeWithKzAccent } from "../../../lib/kz-accent-normalizer";
import { normalizeWithOpenAI } from "../../../lib/openai-normalizer";
import { normalizeWithPipelineV2 } from "../../../lib/normalization-v2";
import { normalizeWithRuAccent } from "../../../lib/ruaccent-normalizer";
import { isLikelyRussianNameForm } from "../../../lib/russian-name-routing";
import { isPlausibleCyrillicNamePartForRescue } from "../../../lib/unknown-rescue";
import { saveHistoryRecord } from "../../../db/history";

export const runtime = "nodejs";

const KZ_ACCENT_EXPERIMENTAL =
  process.env.KZ_ACCENT_EXPERIMENTAL?.toLowerCase() !== "false";
const NORMALIZATION_PIPELINE = process.env.NORMALIZATION_PIPELINE ?? "v2";

export async function POST(request: Request): Promise<Response> {
  let body: { value?: unknown; recordHistory?: unknown };

  try {
    body = (await request.json()) as {
      value?: unknown;
      recordHistory?: unknown;
    };
  } catch {
    return Response.json({ error: "Некорректный запрос" }, { status: 400 });
  }

  if (typeof body.value !== "string" || body.value.length > 120) {
    return Response.json(
      { error: "Ожидается одна строка длиной до 120 символов" },
      { status: 400 },
    );
  }

  const localDecision = decideLocally(body.value);
  if (localDecision.kind === "unknown") {
    if (body.recordHistory !== false) {
      await saveHistoryRecord({
        input: body.value,
        result: localDecision.result,
        source: "local",
      });
    }
    return Response.json({ result: localDecision.result, source: "local" });
  }

  if (NORMALIZATION_PIPELINE === "v2") {
    try {
      const normalized = await normalizeWithPipelineV2(localDecision.input);
      if (body.recordHistory !== false) {
        await saveHistoryRecord({
          input: localDecision.input,
          result: normalized.result,
          source: normalized.source === "openai-spelling" ? "openai" : "local",
          model: normalized.model,
        });
      }
      return Response.json(normalized);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "UNKNOWN_ERROR";
      const missingKey = detail === "OPENAI_API_KEY_NOT_CONFIGURED";
      return Response.json(
        {
          error: missingKey
            ? "API-ключ не настроен"
            : "Не удалось обработать строку через безопасный маршрут v2",
          detail,
          pipeline: "v2",
        },
        { status: missingKey ? 503 : 502 },
      );
    }
  }

  if (KZ_ACCENT_EXPERIMENTAL) {
    try {
      const normalized = await normalizeWithOpenAI(localDecision.input);
      if (normalized.result === "UNKNOWN") {
        const rescued = isPlausibleCyrillicNamePartForRescue(
          localDecision.input,
        )
          ? await normalizeWithKzAccent(localDecision.input)
          : null;

        if (rescued) {
          const rescueModel = `${rescued.model}-rescued`;
          if (body.recordHistory !== false) {
            await saveHistoryRecord({
              input: localDecision.input,
              result: rescued.result,
              source: "local",
              model: rescueModel,
            });
          }
          return Response.json({
            result: rescued.result,
            source: "kz-accent-rescue",
            model: rescueModel,
            rescuedFromUnknown: true,
          });
        }

        if (body.recordHistory !== false) {
          await saveHistoryRecord({
            input: localDecision.input,
            result: normalized.result,
            source: "openai",
            model: normalized.model,
          });
        }
        return Response.json({
          result: normalized.result,
          source: "openai",
          model: normalized.model,
        });
      }

      const cleaned = normalized.result.replaceAll("+", "");
      const localAccent = await normalizeWithKzAccent(cleaned);
      if (localAccent) {
        if (body.recordHistory !== false) {
          await saveHistoryRecord({
            input: localDecision.input,
            result: localAccent.result,
            source: "local",
            model: localAccent.model,
          });
        }
        return Response.json({
          result: localAccent.result,
          source: "kz-accent",
          model: localAccent.model,
        });
      }

      if (body.recordHistory !== false) {
        await saveHistoryRecord({
          input: localDecision.input,
          result: normalized.result,
          source: "openai",
          model: normalized.model,
        });
      }
      return Response.json({
        result: normalized.result,
        source: "openai",
        model: normalized.model,
      });
    } catch {
      // Preserve the former RUAccent/GPT pipeline as a safe fallback.
    }
  }

  if (isLikelyRussianNameForm(localDecision.input)) {
    const ruaccent = await normalizeWithRuAccent(localDecision.input);
    if (ruaccent) {
      if (body.recordHistory !== false) {
        await saveHistoryRecord({
          input: localDecision.input,
          result: ruaccent.result,
          source: "local",
          model: ruaccent.model,
        });
      }
      return Response.json({
        result: ruaccent.result,
        source: "ruaccent",
        model: ruaccent.model,
      });
    }
  }

  try {
    const normalized = await normalizeWithOpenAI(localDecision.input);
    if (body.recordHistory !== false) {
      await saveHistoryRecord({
        input: localDecision.input,
        result: normalized.result,
        source: "openai",
        model: normalized.model,
      });
    }
    return Response.json({
      result: normalized.result,
      source: "openai",
      model: normalized.model,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const missingKey = detail === "OPENAI_API_KEY_NOT_CONFIGURED";
    return Response.json(
      {
        error: missingKey
          ? "API-ключ не настроен"
          : "Не удалось обработать строку через GPT",
        detail,
      },
      { status: missingKey ? 503 : 502 },
    );
  }
}
