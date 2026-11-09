const PLAUSIBLE_NAME_PART = /^\p{L}+(?:[-'’]\p{L}+)*$/u;
const CYRILLIC_NAME_PART = /^[\p{Script=Cyrillic}]+(?:[-'’][\p{Script=Cyrillic}]+)*$/u;
const VOWELS = new Set(
  Array.from("аеёиоуыэюяәіүұөєїaeiouy").map((letter) =>
    letter.normalize("NFC"),
  ),
);

function lettersOnly(value: string): string[] {
  return Array.from(value).filter((character) => /\p{L}/u.test(character));
}

/**
 * A deliberately conservative guard used only after GPT answered UNKNOWN.
 * False deletion is more expensive than keeping a questionable name part.
 */
export function isPlausibleNamePartForRescue(value: string): boolean {
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (
    normalized.length < 2 ||
    normalized.length > 40 ||
    !PLAUSIBLE_NAME_PART.test(normalized)
  ) {
    return false;
  }

  const letters = lettersOnly(normalized);
  if (!letters.some((letter) => VOWELS.has(letter))) return false;

  // Long repetitions are deterministic noise, not rare spelling.
  if (letters.length >= 4 && new Set(letters).size === 1) return false;
  return true;
}

export function isPlausibleCyrillicNamePartForRescue(
  value: string,
): boolean {
  const normalized = value.normalize("NFC").trim().toLowerCase();
  return (
    isPlausibleNamePartForRescue(normalized) &&
    CYRILLIC_NAME_PART.test(normalized)
  );
}
