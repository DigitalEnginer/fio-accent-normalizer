import { prepareInput } from "./normalization";
import { validateModelResult, type ValidationResult } from "./result-validator";

export type LocalDecision =
  | { kind: "unknown"; result: "UNKNOWN" }
  | { kind: "model_required"; input: string };

export function decideLocally(rawInput: string): LocalDecision {
  const prepared = prepareInput(rawInput);

  if (prepared.kind === "unknown") {
    return prepared;
  }

  return { kind: "model_required", input: prepared.value };
}

export function acceptModelResult(rawResult: string): ValidationResult {
  return validateModelResult(rawResult);
}
