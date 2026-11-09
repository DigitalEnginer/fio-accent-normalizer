import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourcePath = path.join(root, "review", "grouped-review-data.json");
const wikiPath = path.join(root, "review", "wiktionary-research.json");
const decisionsPath = path.join(root, "review", "manual-web-decisions.json");
const outputPath = path.join(root, "review", "researched-review-data.json");

const [source, wiki, decisions] = await Promise.all([
  fs.readFile(sourcePath, "utf8").then(JSON.parse),
  fs.readFile(wikiPath, "utf8").then(JSON.parse),
  fs.readFile(decisionsPath, "utf8").then(JSON.parse),
]);

const wikiById = new Map(wiki.rows.map((row) => [row.id, row]));
const decisionById = new Map(decisions.map((row) => [row.id, row]));

const rows = source.rows.map((row) => {
  const wikiRow = wikiById.get(row.id);
  const decision = decisionById.get(row.id);
  const wikiUrls = (wikiRow?.research_sources || []).map((item) => item.url);

  if (decision) {
    return {
      ...row,
      human_status: decision.status,
      human_output: decision.status === "Исправлено вручную" ? decision.result : "",
      reviewer_notes: decision.result
        ? `Интернет-проверка: ${decision.evidence}. Итог: ${decision.result}`
        : `Интернет-проверка: ${decision.evidence}`,
      research_source_url: decision.source_url,
      research_evidence: decision.evidence,
    };
  }

  return {
    ...row,
    human_status: "Не уверен",
    human_output: "",
    reviewer_notes: "Точного подтверждения ударения именно этой части ФИО в доступных интернет-источниках не найдено",
    research_source_url: wikiUrls.join("\n"),
    research_evidence: wikiUrls.length
      ? "Найдена одноимённая словарная статья, но её недостаточно для надёжного подтверждения части ФИО"
      : "Точного источника с явно обозначенным ударением не найдено",
  };
});

const statusCounts = rows.reduce((acc, row) => {
  acc[row.human_status] = (acc[row.human_status] || 0) + 1;
  return acc;
}, {});

const payload = {
  ...source,
  title: "Интернет-проверка ударений: grouped-300k",
  selection_method: `${source.selection_method}; Wiktionary + адресный веб-поиск спорных форм`,
  rows,
  research_summary: {
    checked: rows.length,
    confirmed: rows.filter((row) => row.human_status !== "Не уверен").length,
    uncertain: rows.filter((row) => row.human_status === "Не уверен").length,
    status_counts: statusCounts,
  },
};

await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, ...payload.research_summary }, null, 2));
