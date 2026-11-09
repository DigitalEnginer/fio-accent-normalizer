import {
  NAME_NORMALIZER_OUTPUT_SCHEMA,
  NAME_NORMALIZER_PROMPT,
} from "./name-normalizer-prompt";
import { acceptModelResult } from "./local-pipeline";

type OpenAIResponse = {
  error?: { message?: string };
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
};

export type OpenAINormalization = {
  result: string;
  model: string;
};

function extractOutputText(response: OpenAIResponse): string | null {
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return null;
}

export async function normalizeWithOpenAI(
  input: string,
): Promise<OpenAINormalization> {
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
      instructions: NAME_NORMALIZER_PROMPT,
      input,
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "normalized_name",
          strict: true,
          schema: NAME_NORMALIZER_OUTPUT_SCHEMA,
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new Error("OPENAI_INVALID_JSON");
  }

  const result =
    typeof parsed === "object" && parsed !== null && "result" in parsed
      ? (parsed as { result?: unknown }).result
      : null;

  if (typeof result !== "string") throw new Error("OPENAI_MISSING_RESULT");

  const validation = acceptModelResult(result);
  if (!validation.valid) {
    throw new Error(`OPENAI_INVALID_RESULT: ${validation.error}`);
  }

  return { result: validation.value, model };
}
