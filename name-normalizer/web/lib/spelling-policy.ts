export function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

export function canApplyCorrection(
  input: string,
  normalized: string,
  confidence: "high" | "low",
): boolean {
  void input;
  void confidence;
  // GPT has already made an explicit CORRECT decision using a strict schema.
  // Apply it even when several letters change; corrected rows still go through
  // operator review in the batch UI. Requiring one Cyrillic name part prevents
  // Latin text or arbitrary content from reaching the Cyrillic accent model.
  return /^[\p{Script=Cyrillic}]+(?:[-'’][\p{Script=Cyrillic}]+)*$/u.test(
    normalized,
  );
}
