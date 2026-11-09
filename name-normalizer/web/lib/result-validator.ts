const VOWELS = new Set(
  Array.from("аәеёиіоөуұүыэюяaeiouy").map((letter) => letter.normalize("NFC")),
);

export type ValidationResult =
  | { valid: true; value: string }
  | { valid: false; error: string };

export function validateModelResult(rawValue: string): ValidationResult {
  const value = rawValue.normalize("NFC").trim();

  if (value === "UNKNOWN") {
    return { valid: true, value };
  }

  if (!value) {
    return { valid: false, error: "Пустой ответ модели" };
  }

  if (value.includes("\n") || value.includes("\r")) {
    return { valid: false, error: "Ответ содержит несколько строк" };
  }

  if (value !== value.toLowerCase()) {
    return { valid: false, error: "Результат должен быть в нижнем регистре" };
  }

  if (/\s/u.test(value)) {
    return { valid: false, error: "Результат содержит пробелы" };
  }

  if (!/^[\p{L}+\-'’]+$/u.test(value)) {
    return { valid: false, error: "Результат содержит недопустимые символы" };
  }

  const plusPositions = Array.from(value.matchAll(/\+/gu), (match) => match.index);
  if (plusPositions.length === 0) {
    return { valid: false, error: "В результате отсутствует знак ударения" };
  }

  for (const position of plusPositions) {
    const nextCharacter = Array.from(value.slice(position + 1))[0];
    if (!nextCharacter || !VOWELS.has(nextCharacter)) {
      return {
        valid: false,
        error: "Знак ударения должен стоять непосредственно перед гласной",
      };
    }
  }

  return { valid: true, value };
}
