import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const workbookPath = path.resolve(
  process.argv[2] || "outputs/name-accent-audit/gold-review-researched-500.xlsx",
);
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
const sheet = workbook.worksheets.getItem("Проверка");
const values = sheet.getUsedRange(true).values;
const headers = values[0].map(String);
const byHeader = Object.fromEntries(headers.map((header, index) => [header, index]));
const expected = {
  "GOLD-0112": ["Верна база", "https://ru.wiktionary.org/"],
  "GOLD-0168": ["Верна модель", "https://ru.wikipedia.org/"],
  "GOLD-0260": ["Не уверен", "https://ru.wiktionary.org/"],
  "GOLD-0297": ["Верна база", "https://ru.wikipedia.org/"],
  "GOLD-0459": ["Верна база", "https://o-krohe.ru/"],
};

if (values.length !== 501) throw new Error(`Expected 501 rows including header, got ${values.length}`);
if (headers.length !== 17) throw new Error(`Expected 17 columns, got ${headers.length}`);

for (const [id, [status, sourcePrefix]] of Object.entries(expected)) {
  const row = values.find((candidate) => candidate[byHeader.ID] === id);
  if (!row) throw new Error(`Missing row ${id}`);
  if (row[byHeader["Статус эксперта"]] !== status) throw new Error(`Unexpected status for ${id}`);
  if (!String(row[byHeader["Источник"]]).startsWith(sourcePrefix)) throw new Error(`Unexpected source for ${id}`);
}

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "formula error scan",
});

console.log(JSON.stringify({
  workbookPath,
  dataRows: values.length - 1,
  columns: headers.length,
  verifiedRows: Object.keys(expected),
  formulaErrors: errors.ndjson,
}, null, 2));
