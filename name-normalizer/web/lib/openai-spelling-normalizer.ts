type OpenAIResponse = {
  error?: { message?: string };
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
};

export type SpellingDecision = "KEEP" | "CORRECT" | "UNKNOWN";
export type SpellingConfidence = "high" | "low";
export type UnknownKind = "none" | "technical" | "clear_non_name" | "uncertain";

export type OpenAISpellingNormalization = {
  decision: SpellingDecision;
  normalized: string;
  confidence: SpellingConfidence;
  unknownKind: UnknownKind;
  model: string;
};

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
- Для очевидно повреждённого имени с однозначным восстановлением, например пропущенными несколькими буквами, используй CORRECT с confidence=high.
- unknownKind=none для KEEP и CORRECT.
- Для UNKNOWN используй unknownKind=technical для цифр/символов/служебных данных, clear_non_name для очевидного слова или названия, uncertain только если ты сомневаешься. Не используй uncertain для явно известных обычных слов.
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
} as const;

function extractOutputText(response: OpenAIResponse): string | null {
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return null;
}

export async function normalizeSpellingWithOpenAI(
  input: string,
): Promise<OpenAISpellingNormalization> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-5.6-sol";
  if (!apiKey) throw new Error("OPENAI_API_KEY_NOT_CONFIGURED");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
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
    signal: AbortSignal.timeout(45_000),
  });

  const payload = (await response.json()) as OpenAIResponse;
  if (!response.ok) {
    throw new Error(payload.error?.message || `OPENAI_HTTP_${response.status}`);
  }

  const outputText = extractOutputText(payload);
  if (!outputText) throw new Error("OPENAI_EMPTY_OUTPUT");
  const parsed = JSON.parse(outputText) as Record<string, unknown>;
  const decision = parsed.decision;
  const confidence = parsed.confidence;
  const unknownKind = parsed.unknownKind;
  const normalized =
    typeof parsed.normalized === "string"
      ? parsed.normalized.normalize("NFC").trim().toLowerCase()
      : null;

  if (
    !["KEEP", "CORRECT", "UNKNOWN"].includes(String(decision)) ||
    !["high", "low"].includes(String(confidence)) ||
    !["none", "technical", "clear_non_name", "uncertain"].includes(
      String(unknownKind),
    ) ||
    normalized === null ||
    normalized.includes("+") ||
    /\s/u.test(normalized) ||
    (decision !== "UNKNOWN" && !/^[\p{L}\-'’]+$/u.test(normalized)) ||
    (decision === "UNKNOWN" && normalized !== "") ||
    (decision === "UNKNOWN" && unknownKind === "none") ||
    (decision !== "UNKNOWN" && unknownKind !== "none")
  ) {
    throw new Error("OPENAI_INVALID_SPELLING_DECISION");
  }

  return {
    decision: decision as SpellingDecision,
    normalized,
    confidence: confidence as SpellingConfidence,
    unknownKind: unknownKind as UnknownKind,
    model,
  };
}
