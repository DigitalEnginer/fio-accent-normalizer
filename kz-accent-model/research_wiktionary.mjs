import fs from "node:fs/promises";

const inputPath = process.argv[2] || "review/grouped-review-data.json";
const outputPath = process.argv[3] || "review/wiktionary-research.json";
const payload = JSON.parse(await fs.readFile(inputPath, "utf8"));

const ACCENTS = /[\u0300\u0301]/gu;
const tokenPattern = /[\p{Script=Cyrillic}][\p{Script=Cyrillic}\u0300\u0301-]*/gu;

function baseForm(value) {
  return value.normalize("NFD").replace(ACCENTS, "").normalize("NFC").toLowerCase();
}

function toPlus(value) {
  const decomposed = value.normalize("NFD");
  let result = "";
  let lastVowelStart = -1;
  for (const char of decomposed) {
    if (char === "\u0301") {
      if (lastVowelStart >= 0 && result[lastVowelStart - 1] !== "+") {
        result = `${result.slice(0, lastVowelStart)}+${result.slice(lastVowelStart)}`;
      }
      continue;
    }
    if (char === "\u0300") continue;
    result += char;
    if ("аеёиоуыэюяәіүұө".includes(char.toLowerCase())) lastVowelStart = result.length - 1;
  }
  return result.normalize("NFC").toLowerCase();
}

function extractCandidates(wikitext, target) {
  const candidates = new Set();
  for (const token of wikitext.match(tokenPattern) || []) {
    if (baseForm(token) !== target) continue;
    const hasPrimary = token.normalize("NFD").includes("\u0301");
    const hasYo = /ё/iu.test(token);
    if (!hasPrimary && !hasYo) continue;
    let rendered = toPlus(token);
    if (!hasPrimary && hasYo) rendered = rendered.replace(/ё/iu, (match) => `+${match.toLowerCase()}`);
    if ((rendered.match(/\+/g) || []).length >= 1) candidates.add(rendered);
  }
  return [...candidates];
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchBatch(domain, names) {
  const url = new URL(`https://${domain}/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "revisions");
  url.searchParams.set("rvprop", "content");
  url.searchParams.set("rvslots", "main");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", names.join("|"));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, { headers: { "User-Agent": "KazakhstanNameAccentAudit/1.0 (local research)" } });
    if (response.ok) return response.json();
    if (response.status !== 429) throw new Error(`${domain}: HTTP ${response.status}`);
    const retryAfter = Number(response.headers.get("retry-after") || 2);
    await delay(Math.max(2000, retryAfter * 1000) * (attempt + 1));
  }
  throw new Error(`${domain}: repeated HTTP 429`);
}

async function researchDomain(domain, rows) {
  const results = new Map();
  for (let offset = 0; offset < rows.length; offset += 50) {
    const batch = rows.slice(offset, offset + 50);
    const data = await fetchBatch(domain, batch.map((row) => row.clean_input));
    for (const page of data.query?.pages || []) {
      if (page.missing) continue;
      const requested = baseForm(page.title);
      const row = batch.find((item) => item.clean_input === requested);
      if (!row) continue;
      const text = page.revisions?.[0]?.slots?.main?.content || "";
      const candidates = extractCandidates(text, row.clean_input);
      if (candidates.length) {
        results.set(row.id, {
          candidates,
          url: `https://${domain}/wiki/${encodeURIComponent(page.title.replaceAll(" ", "_"))}`,
        });
      }
    }
    await delay(1200);
  }
  return results;
}

const rows = payload.rows;
const ru = await researchDomain("ru.wiktionary.org", rows);
await delay(3000);
const en = await researchDomain("en.wiktionary.org", rows);

const researched = rows.map((row) => {
  const sources = [];
  const variants = [];
  for (const [label, result] of [["ru.wiktionary", ru.get(row.id)], ["en.wiktionary", en.get(row.id)]]) {
    if (!result) continue;
    sources.push({ source: label, url: result.url, candidates: result.candidates });
    variants.push(...result.candidates);
  }
  const unique = [...new Set(variants)];
  let recommendation = "";
  let status = "Не уверен";
  let note = "Точного ударения в проверенных словарных статьях не найдено";
  if (unique.length === 1) {
    recommendation = unique[0];
    if (recommendation === row.dataset_output && recommendation === row.model_output) status = "Верна база";
    else if (recommendation === row.dataset_output) status = "Верна база";
    else if (recommendation === row.model_output) status = "Верна модель";
    else status = "Исправлено вручную";
    note = `Точная словарная форма: ${recommendation}`;
  } else if (unique.length > 1) {
    note = `Найдены разные словарные варианты: ${unique.join(", ")}`;
  }
  return { ...row, research_sources: sources, research_variants: unique, research_recommendation: recommendation, human_status: status, human_output: status === "Исправлено вручную" ? recommendation : "", reviewer_notes: note };
});

const summary = {
  input: inputPath,
  rows: researched.length,
  exact_single_variant: researched.filter((row) => row.research_variants.length === 1).length,
  ambiguous_variants: researched.filter((row) => row.research_variants.length > 1).length,
  not_found: researched.filter((row) => row.research_variants.length === 0).length,
  status_counts: Object.fromEntries([...new Set(researched.map((row) => row.human_status))].sort().map((status) => [status, researched.filter((row) => row.human_status === status).length])),
};
await fs.writeFile(outputPath, JSON.stringify({ ...summary, rows: researched }, null, 2), "utf8");
console.log(JSON.stringify(summary, null, 2));
