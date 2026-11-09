import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { normalizePipeline } from "./openai_pipeline.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.OPENAI_PROXY_PORT || 8767);
const MAX_BODY_BYTES = 256 * 1024;
const RETRY_DELAYS_MS = [0, 400, 1_200];
const RETRYABLE_STATUS = new Set([408, 409, 429]);

async function loadEnvFile() {
  const envPath = resolve(process.cwd(), ".env.local");
  let source;
  try {
    source = await readFile(envPath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

function allowedOrigin(request) {
  const origin = request.headers.origin;
  return origin === "http://localhost:3000" || origin === "http://127.0.0.1:3000"
    ? origin
    : null;
}

function sendJson(response, status, payload, request = null) {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  };
  const origin = request ? allowedOrigin(request) : null;
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  response.writeHead(status, headers);
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isRetryable(status) {
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function requestOpenAI(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      status: 503,
      body: JSON.stringify({ error: { message: "OPENAI_API_KEY_NOT_CONFIGURED" } }),
      requestId: null,
    };
  }

  let lastError = null;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    if (RETRY_DELAYS_MS[attempt] > 0) await wait(RETRY_DELAYS_MS[attempt]);
    try {
      const upstream = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25_000),
      });
      const body = await upstream.text();
      const result = {
        status: upstream.status,
        body,
        requestId: upstream.headers.get("x-request-id"),
      };
      if (!isRetryable(upstream.status) || attempt === RETRY_DELAYS_MS.length - 1) {
        return result;
      }
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_DELAYS_MS.length - 1) break;
    }
  }

  return {
    status: 502,
    body: JSON.stringify({
      error: {
        message:
          lastError instanceof Error ? lastError.message : "OPENAI_PROXY_UPSTREAM_ERROR",
      },
    }),
    requestId: null,
  };
}

await loadEnvFile();

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    const origin = allowedOrigin(request);
    response.writeHead(204, {
      ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, {
      status: "ok",
      configured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || "gpt-5.6-sol",
    }, request);
    return;
  }

  if (request.method === "POST" && request.url === "/normalize") {
    try {
      const body = await readJsonBody(request);
      if (typeof body?.value !== "string" || body.value.length > 120) {
        sendJson(response, 400, {
          error: "Ожидается одна строка длиной до 120 символов",
        }, request);
        return;
      }
      sendJson(response, 200, await normalizePipeline(body.value, requestOpenAI), request);
    } catch (error) {
      sendJson(response, 502, {
        error: "Не удалось обработать строку через локальный GPT-маршрут",
        detail: error instanceof Error ? error.message : "OPENAI_PROXY_ERROR",
        pipeline: "v2",
      }, request);
    }
    return;
  }

  if (request.method !== "POST" || request.url !== "/responses") {
    sendJson(response, 404, { error: { message: "NOT_FOUND" } }, request);
    return;
  }

  try {
    const payload = await readJsonBody(request);
    if (!payload || typeof payload !== "object" || typeof payload.model !== "string") {
      sendJson(response, 400, { error: { message: "INVALID_OPENAI_REQUEST" } }, request);
      return;
    }

    const upstream = await requestOpenAI(payload);
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(upstream.body),
      "Cache-Control": "no-store",
    };
    if (upstream.requestId) headers["x-openai-request-id"] = upstream.requestId;
    response.writeHead(upstream.status, headers);
    response.end(upstream.body);
  } catch (error) {
    sendJson(response, error instanceof SyntaxError ? 400 : 500, {
      error: {
        message: error instanceof Error ? error.message : "OPENAI_PROXY_ERROR",
      },
    }, request);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OpenAI proxy ready at http://${HOST}:${PORT}`);
});
