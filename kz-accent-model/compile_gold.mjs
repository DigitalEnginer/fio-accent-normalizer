import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const root = process.cwd();
const workbookPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "outputs", "name-accent-audit", "gold-review-500.xlsx");
const outputDir = path.join(root, "outputs", "name-accent-audit");
const vowels = new Set([..."аеёиоуыэюяәіүұөєї"]);

const input = await FileBlob.load(workbookPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem("Проверка");
const used = sheet.getUsedRange(true);
const values = used.values;
const headers = values[0];
const index = Object.fromEntries(headers.map((value, position) => [String(value), position]));

const requiredHeaders = [
  "ID", "Очищенная строка", "Ответ базы", "Ответ модели", "Статус эксперта", "Правильный результат",
];
for (const header of requiredHeaders) {
  if (!(header in index)) throw new Error(`Missing required column: ${header}`);
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase().normalize("NFC");
}

function validateAccent(cleanInput, output) {
  const errors = [];
  const marks = [...output].filter((char) => char === "+").length;
  if (marks < 1 || marks > 2) errors.push("должно быть одно или два ударения");
  if (output.replaceAll("+", "") !== cleanInput) errors.push("результат без + не совпадает с очищенной строкой");
  for (let position = 0; position < output.length; position += 1) {
    if (output[position] === "+" && !vowels.has(output[position + 1])) {
      errors.push("символ + должен стоять непосредственно перед гласной");
      break;
    }
  }
  return errors;
}

const accepted = [];
const invalid = [];
const counts = { pending: 0, uncertain: 0, rejected: 0, accepted: 0 };
for (const row of values.slice(1)) {
  const id = normalize(row[index["ID"]]);
  if (!id) continue;
  const status = String(row[index["Статус эксперта"]] ?? "Не проверено").trim();
  const cleanInput = normalize(row[index["Очищенная строка"]]);
  let output = "";
  if (status === "Верна база") output = normalize(row[index["Ответ базы"]]);
  else if (status === "Верна модель") output = normalize(row[index["Ответ модели"]]);
  else if (status === "Исправлено вручную") output = normalize(row[index["Правильный результат"]]);
  else if (status === "Не ФИО") { counts.rejected += 1; continue; }
  else if (status === "Не уверен") { counts.uncertain += 1; continue; }
  else { counts.pending += 1; continue; }

  const rowErrors = validateAccent(cleanInput, output);
  if (rowErrors.length) {
    invalid.push({ id, status, clean_input: cleanInput, output, errors: rowErrors });
    continue;
  }
  accepted.push({ input: cleanInput, output, source_id: id, decision: status });
  counts.accepted += 1;
}

await fs.mkdir(outputDir, { recursive: true });
const report = {
  workbook: workbookPath,
  rows_seen: values.length - 1,
  ...counts,
  invalid: invalid.length,
  invalid_rows: invalid,
};
await fs.writeFile(path.join(outputDir, "gold-validation.json"), JSON.stringify(report, null, 2), "utf8");

if (invalid.length === 0) {
  const escapeCsv = (value) => {
    const text = String(value ?? "");
    return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = ["input;output;source_id;decision"];
  for (const row of accepted) lines.push([row.input, row.output, row.source_id, row.decision].map(escapeCsv).join(";"));
  await fs.writeFile(path.join(outputDir, "gold-test.csv"), `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

console.log(JSON.stringify(report, null, 2));
if (invalid.length) process.exitCode = 1;

