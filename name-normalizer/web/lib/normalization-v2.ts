import { normalizeWithKzAccent } from "./kz-accent-normalizer";
import { normalizeSpellingWithOpenAI } from "./openai-spelling-normalizer";
import { normalizeWithRuAccent } from "./ruaccent-normalizer";
import { isLikelyRussianNameForm } from "./russian-name-routing";
import { canApplyCorrection } from "./spelling-policy";
import { isPlausibleCyrillicNamePartForRescue } from "./unknown-rescue";

export type NormalizationV2Result = {
  result: string;
  source: string;
  model: string | null;
  pipeline: "v2";
  spellingDecision: "KEEP" | "CORRECT" | "UNKNOWN";
  unknownKind: "none" | "technical" | "clear_non_name" | "uncertain";
  correctionApplied: boolean;
  spellingSuggestion: string | null;
  requiresAttention: boolean;
  attentionReason: string | null;
  rescuedFromUnknown?: boolean;
};

async function applyLocalAccent(value: string) {
  const local = await normalizeWithKzAccent(value);
  if (local) return local;
  if (isLikelyRussianNameForm(value)) return normalizeWithRuAccent(value);
  return null;
}

export async function normalizeWithPipelineV2(
  input: string,
): Promise<NormalizationV2Result> {
  const spelling = await normalizeSpellingWithOpenAI(input);

  if (spelling.decision === "UNKNOWN") {
    const rescued =
      spelling.unknownKind === "uncertain" &&
      isPlausibleCyrillicNamePartForRescue(input)
      ? await applyLocalAccent(input)
      : null;
    if (rescued) {
      return {
        result: rescued.result,
        source: "local-accent",
        model: `${rescued.model}-rescued`,
        pipeline: "v2",
        spellingDecision: "UNKNOWN",
        unknownKind: spelling.unknownKind,
        correctionApplied: false,
        spellingSuggestion: null,
        requiresAttention: true,
        attentionReason: "Спасено после UNKNOWN",
        rescuedFromUnknown: true,
      };
    }
    return {
      result: "UNKNOWN",
      source: "openai-spelling",
      model: spelling.model,
      pipeline: "v2",
      spellingDecision: "UNKNOWN",
      unknownKind: spelling.unknownKind,
      correctionApplied: false,
      spellingSuggestion: null,
      requiresAttention: false,
      attentionReason: null,
    };
  }

  const correctionApplied =
    spelling.decision === "CORRECT" &&
    canApplyCorrection(input, spelling.normalized, spelling.confidence);
  const base = correctionApplied ? spelling.normalized : input;
  const suggestion =
    spelling.decision === "CORRECT" && !correctionApplied
      ? spelling.normalized
      : null;
  const accented = await applyLocalAccent(base);

  if (!accented) {
    return {
      result: base,
      source: "local-accent-unavailable",
      model: null,
      pipeline: "v2",
      spellingDecision: spelling.decision,
      unknownKind: spelling.unknownKind,
      correctionApplied,
      spellingSuggestion: suggestion,
      requiresAttention: true,
      attentionReason: "Локальная модель не смогла поставить ударение",
    };
  }

  return {
    result: accented.result,
    source: "local-accent",
    model: accented.model,
    pipeline: "v2",
    spellingDecision: spelling.decision,
    unknownKind: spelling.unknownKind,
    correctionApplied,
    spellingSuggestion: suggestion,
    requiresAttention: spelling.decision === "CORRECT",
    attentionReason: correctionApplied
      ? "Применено уверенное исправление GPT"
      : suggestion
        ? `GPT предлагает: ${suggestion}. Изменение не применено автоматически`
        : null,
  };
}
