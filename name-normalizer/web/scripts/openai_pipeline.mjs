const EXCEL_ERRORS = new Set([
  "#name?",
  "#value!",
  "#n/a",
  "#ref!",
  "#div/0!",
  "#num!",
  "#null!",
]);
const CYRILLIC_NAME_PART = /^[\p{Script=Cyrillic}]+(?:[-'’][\p{Script=Cyrillic}]+)*$/u;
const PLAUSIBLE_NAME_PART = /^\p{L}+(?:[-'’]\p{L}+)*$/u;
const VOWELS = new Set(Array.from("аеёиоуыэюяәіүұөєїaeiouy"));
const RUSSIAN_NAMES = new Set([
  "александр", "алексей", "анастасия", "андрей", "анна", "артем", "артём",
  "валентина", "виктор", "виктория", "владимир", "галина", "дмитрий",
  "евгений", "екатерина", "елена", "иван", "ирина", "марина", "мария",
  "михаил", "наталья", "николай", "ольга", "павел", "сергей", "светлана",
  "татьяна", "юлия",
]);

const SPELLING_PROMPT = `
Ты проверяешь одну отдельную часть ФИО человека в Казахстане: имя, фамилию или отчество.

Ты отвечаешь только за распознавание и написание. Не ставь ударение и никогда не добавляй символ +.

Решения:
- KEEP: кириллическая строка может быть редким или незнакомым именем, фамилией или отчеством; сохрани все буквы без изменений.
- CORRECT: это имя с практически однозначной опечаткой, пропущенными буквами, соседней клавишей, неправильной раскладкой или латинским написанием. Любое настоящее имя на латинице обязательно переводи в кириллицу.
- UNKNOWN: строка явно не является именем, фамилией или отчеством: технический мусор, служебная информация, общеупотребительное иностранное слово, название продукта/компании или искусственно образованное слово, которое только внешне похоже на фамилию.

Ограничения:
- Не пытайся сделать редкое имя более распространённым.
- Если возможны несколько именных вариантов, выбери KEEP.
- Для CORRECT confidence=high используй только практически однозначное исправление.
- Для спорного исправления верни CORRECT с confidence=low: система покажет его оператору как подсказку, но не применит автоматически.
- Для очевидно повреждённого имени с однозначным восстановлением используй CORRECT с confidence=high.
- unknownKind=none для KEEP и CORRECT.
- Для UNKNOWN используй unknownKind=technical для цифр/символов/служебных данных, clear_non_name для очевидного слова или названия, uncertain только если ты сомневаешься.
- normalized всегда одно слово в нижнем регистре без ударения и без +.
- При KEEP normalized должен совпадать со входом после приведения к нижнему регистру.
- При UNKNOWN normalized должен быть пустой строкой.

Примеры:
аблай -> KEEP, аблай, high
аблае -> CORRECT, аблай, high
абдикериова -> CORRECT, абдикеримова, high
сунетбай -> KEEP, сунетбай, high
сүндетбай -> KEEP, сүндетбай, high
бешкемпір -> KEEP, бешкемпір, high
покрава -> KEEP, покрава, high
есмь -> KEEP, есмь, low
саңдк -> CORRECT, сағындық, high
saydiganiyev -> CORRECT, сайдиганиев, high
apple -> UNKNOWN, пустая строка, high, clear_non_name
dent -> UNKNOWN, пустая строка, high, clear_non_name
prodex -> UNKNOWN, пустая строка, high, clear_non_name
наркоманов -> UNKNOWN, пустая строка, high, clear_non_name
87051234567 -> UNKNOWN, пустая строка, high, technical
`.trim();

const SPELLING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["KEEP", "CORRECT", "UNKNOWN"] },
    normalized: { type: "string" },
    confidence: { type: "string", enum: ["high", "low"] },
    unknownKind: {
      type: "string",
      enum: ["none", "technical", "clear_non_name", "uncertain"],
    },
  },
  required: ["decision", "normalized", "confidence", "unknownKind"],
};

function extractOutputText(response) {
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return null;
}

function normalizeInput(value) {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function isPlausibleCyrillicNamePart(value) {
  if (value.length < 2 || value.length > 40 || !PLAUSIBLE_NAME_PART.test(value)) {
    return false;
  }
  const letters = Array.from(value).filter((character) => /\p{L}/u.test(character));
  if (!letters.some((letter) => VOWELS.has(letter))) return false;
  if (letters.length >= 4 && new Set(letters).size === 1) return false;
  return CYRILLIC_NAME_PART.test(value);
}

function isLikelyRussianName(value) {
  return !/[әіңғүұқөһ]/u.test(value) && /^[а-яё]+$/u.test(value) && RUSSIAN_NAMES.has(value);
}

async function callAccentService(url, value) {
  try {
    const response = await fetch(`${url}/accent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return typeof payload.result === "string"
      ? { result: payload.result, model: payload.model ?? null }
      : null;
  } catch {
    return null;
  }
}

async function applyLocalAccent(value) {
  const local = await callAccentService(
    process.env.KZ_ACCENT_URL || "http://127.0.0.1:8766",
    value,
  );
  if (local) return local;
  if (!isLikelyRussianName(value)) return null;
  return callAccentService(
    process.env.RUACCENT_URL || "http://127.0.0.1:8765",
    value,
  );
}

function parseSpellingResponse(openAI, model) {
  let payload;
  try {
    payload = JSON.parse(openAI.body);
  } catch {
    throw new Error(`OPENAI_HTTP_${openAI.status}`);
  }
  if (openAI.status < 200 || openAI.status >= 300) {
    throw new Error(payload.error?.message || `OPENAI_HTTP_${openAI.status}`);
  }
  const outputText = extractOutputText(payload);
  if (!outputText) throw new Error("OPENAI_EMPTY_OUTPUT");
  const spelling = JSON.parse(outputText);
  spelling.normalized =
    typeof spelling.normalized === "string"
      ? spelling.normalized.normalize("NFC").trim().toLowerCase()
      : null;
  if (
    !["KEEP", "CORRECT", "UNKNOWN"].includes(spelling.decision) ||
    !["high", "low"].includes(spelling.confidence) ||
    !["none", "technical", "clear_non_name", "uncertain"].includes(
      spelling.unknownKind,
    ) ||
    spelling.normalized === null ||
    spelling.normalized.includes("+") ||
    /\s/u.test(spelling.normalized) ||
    (spelling.decision !== "UNKNOWN" && !/^\p{L}+(?:[-'’]\p{L}+)*$/u.test(spelling.normalized)) ||
    (spelling.decision === "UNKNOWN" && spelling.normalized !== "") ||
    (spelling.decision === "UNKNOWN" && spelling.unknownKind === "none") ||
    (spelling.decision !== "UNKNOWN" && spelling.unknownKind !== "none")
  ) {
    throw new Error("OPENAI_INVALID_SPELLING_DECISION");
  }
  return { ...spelling, model };
}

export async function normalizePipeline(rawValue, requestOpenAI) {
  const input = normalizeInput(rawValue);
  if (!input || EXCEL_ERRORS.has(input) || !/\p{L}/u.test(input)) {
    return { result: "UNKNOWN", source: "local", model: null, pipeline: "v2" };
  }

  const model = process.env.OPENAI_MODEL || "gpt-5.6-sol";
  const spelling = parseSpellingResponse(
    await requestOpenAI({
      model,
      reasoning: { effort: "medium" },
      instructions: SPELLING_PROMPT,
      input,
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "name_spelling_decision",
          strict: true,
          schema: SPELLING_SCHEMA,
        },
      },
    }),
    model,
  );

  if (spelling.decision === "UNKNOWN") {
    const rescued =
      spelling.unknownKind === "uncertain" && isPlausibleCyrillicNamePart(input)
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
      model,
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
    spelling.decision === "CORRECT" && CYRILLIC_NAME_PART.test(spelling.normalized);
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
    attentionReason:
      spelling.decision === "CORRECT"
        ? correctionApplied
          ? "Применено уверенное исправление GPT"
          : suggestion
            ? `GPT предлагает: ${suggestion}. Изменение не применено автоматически`
            : null
        : null,
  };
}

