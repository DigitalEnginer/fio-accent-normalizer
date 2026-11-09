import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const outputDir = path.join(root, "outputs", "name-gold");
const report = JSON.parse(await fs.readFile(path.join(outputDir, "gold-from-names-report.json"), "utf8"));
const samples = JSON.parse(await fs.readFile(path.join(outputDir, "gold-from-names-samples.json"), "utf8"));
const previewDir = path.join(outputDir, "previews");
await fs.mkdir(previewDir, { recursive: true });

const workbook = Workbook.create();
const summary = workbook.worksheets.add("Сводка");
const sampleSheet = workbook.worksheets.add("Примеры");
const method = workbook.worksheets.add("Методика");
for (const sheet of [summary, sampleSheet, method]) sheet.showGridLines = false;

const red = "#E33D32";
const dark = "#1F2328";
const paleBlue = "#EAF4FB";
const paleYellow = "#FFF6D6";
const muted = "#667085";

summary.mergeCells("A1:F2");
summary.getRange("A1:F2").values = [[report.title]];
summary.getRange("A1:F2").format = {
  fill: dark,
  font: { name: "Aptos Display", bold: true, color: "#FFFFFF", size: 18 },
  verticalAlignment: "center",
};

summary.getRange("A4:B9").values = [
  ["Основной показатель", "Значение"],
  ["Строк в names.csv", report.counts.source_rows],
  ["Принято уникальных пар", report.counts.accepted_unique],
  ["Исключено", report.counts.excluded_total],
  ["Дубликатов объединено", report.counts.duplicate_same],
  ["Доля принятия", null],
];
summary.getRange("B9").formulas = [["=B6/B5"]];
summary.getRange("B5:B8").format.numberFormat = "#,##0";
summary.getRange("B9").format.numberFormat = "0.0%";

summary.getRange("D4:E8").values = [
  ["Разбиение", "Строк"],
  ["train", report.splits.train],
  ["validation", report.splits.validation],
  ["test", report.splits.test],
  ["Всего", null],
];
summary.getRange("E8").formulas = [["=SUM(E5:E7)"]];
summary.getRange("E5:E8").format.numberFormat = "#,##0";

summary.getRange("A12:B15").values = [
  ["Ударений в строке", "Строк"],
  [1, report.stress_marks["1"]],
  [2, report.stress_marks["2"]],
  ["Всего", null],
];
summary.getRange("B15").formulas = [["=SUM(B13:B14)"]];
summary.getRange("B13:B15").format.numberFormat = "#,##0";

summary.getRange("D12:E15").values = [
  ["Алфавитная группа", "Строк"],
  ["Есть казахские буквы", report.script_groups.contains_kazakh_letters],
  ["Общая кириллица", report.script_groups.common_cyrillic_only],
  ["Всего", null],
];
summary.getRange("E15").formulas = [["=SUM(E13:E14)"]];
summary.getRange("E13:E15").format.numberFormat = "#,##0";

summary.getRange("A18:B23").values = [
  ["Причина исключения", "Строк"],
  ["Неверная позиция/число +", report.counts.excluded_invalid_stress],
  ["Не одна кириллическая часть", report.counts.excluded_not_single_cyrillic_token],
  ["Изменён текст, не только ударение", report.counts.excluded_text_changed],
  ["Пустая или неверная длина", report.counts.excluded_empty + report.counts.excluded_length],
  ["Конфликтующие варианты", report.counts.excluded_conflicting_inputs],
];
summary.getRange("B19:B23").format.numberFormat = "#,##0";

for (const range of ["A4:B4", "D4:E4", "A12:B12", "D12:E12", "A18:B18"]) {
  summary.getRange(range).format = { fill: red, font: { bold: true, color: "#FFFFFF" } };
}
for (const range of ["A4:B9", "D4:E8", "A12:B15", "D12:E15", "A18:B23"]) {
  summary.getRange(range).format.borders = { preset: "outside", style: "thin", color: "#D0D5DD" };
}
summary.getRange("D25:F27").merge();
summary.getRange("D25:F27").values = [[`Источник: ${report.source}\nОсновной файл: gold-from-names.csv`]];
summary.getRange("D25:F27").format = { fill: paleBlue, wrapText: true, verticalAlignment: "center", font: { color: muted } };
summary.getRange("A1:F27").format.font = { name: "Aptos", size: 11 };
summary.getRange("A1:F2").format.font = { name: "Aptos Display", bold: true, color: "#FFFFFF", size: 18 };
summary.getRange("A:A").format.columnWidth = 34;
summary.getRange("B:B").format.columnWidth = 18;
summary.getRange("C:C").format.columnWidth = 4;
summary.getRange("D:D").format.columnWidth = 30;
summary.getRange("E:E").format.columnWidth = 18;
summary.getRange("F:F").format.columnWidth = 20;
summary.freezePanes.freezeRows(2);

const sampleHeaders = ["input", "output", "split", "Ударений", "Длина", "Казахские буквы"];
const sampleRows = samples.map((row) => [
  row.input,
  row.output,
  row.split,
  row.stress_count,
  row.length,
  row.has_kazakh_letters ? "Да" : "Нет",
]);
sampleSheet.getRangeByIndexes(0, 0, sampleRows.length + 1, sampleHeaders.length).values = [sampleHeaders, ...sampleRows];
const table = sampleSheet.tables.add(`A1:F${sampleRows.length + 1}`, true, "GoldSamplesTable");
table.style = "TableStyleMedium2";
table.showBandedRows = true;
table.showFilterButton = true;
sampleSheet.getRange("A1:F1").format = { fill: red, font: { bold: true, color: "#FFFFFF" } };
sampleSheet.getRange(`A1:F${sampleRows.length + 1}`).format.font = { name: "Aptos", size: 10 };
for (const [column, width] of [["A:A", 28], ["B:B", 30], ["C:C", 14], ["D:E", 12], ["F:F", 18]]) {
  sampleSheet.getRange(column).format.columnWidth = width;
}
sampleSheet.freezePanes.freezeRows(1);
sampleSheet.freezePanes.freezeColumns(2);

method.mergeCells("A1:F2");
method.getRange("A1:F2").values = [["Как сформирована gold-база"]];
method.getRange("A1:F2").format = { fill: dark, font: { name: "Aptos Display", bold: true, color: "#FFFFFF", size: 18 }, verticalAlignment: "center" };
const methodRows = [
  ["Тип", "Правило"],
  ...report.policy.map((value) => ["Отбор", value]),
  ...report.limitations.map((value) => ["Ограничение", value]),
];
method.getRangeByIndexes(3, 0, methodRows.length, 2).values = methodRows;
method.getRange("A4:B4").format = { fill: red, font: { bold: true, color: "#FFFFFF" } };
method.getRange(`A4:B${3 + methodRows.length}`).format.borders = { preset: "outside", style: "thin", color: "#D0D5DD" };
method.getRange(`B5:B${3 + methodRows.length}`).format.wrapText = true;
method.getRange(`A${5 + report.policy.length}:B${3 + methodRows.length}`).format.fill = paleYellow;
method.getRange("A:A").format.columnWidth = 18;
method.getRange("B:B").format.columnWidth = 100;
method.getRange(`A4:B${3 + methodRows.length}`).format.font = { name: "Aptos", size: 11 };
method.freezePanes.freezeRows(2);

console.log((await workbook.inspect({ kind: "table", sheetId: "Сводка", range: "A1:F27", include: "values,formulas", tableMaxRows: 30, tableMaxCols: 6 })).ndjson);
console.log((await workbook.inspect({ kind: "table", sheetId: "Примеры", range: "A1:F12", include: "values,formulas", tableMaxRows: 12, tableMaxCols: 6 })).ndjson);
console.log((await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: "formula error scan" })).ndjson);

for (const [sheetName, range, fileName] of [
  ["Сводка", "A1:F27", "summary.png"],
  ["Примеры", "A1:F22", "samples.png"],
  ["Методика", `A1:B${3 + methodRows.length}`, "method.png"],
]) {
  const preview = await workbook.render({ sheetName, range, scale: 1.2, format: "png" });
  await fs.writeFile(path.join(previewDir, fileName), new Uint8Array(await preview.arrayBuffer()));
}

const outputPath = path.join(outputDir, "gold-from-names-report.xlsx");
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, samples: sampleRows.length }));
