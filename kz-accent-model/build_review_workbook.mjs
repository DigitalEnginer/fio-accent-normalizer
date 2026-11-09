import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const dataPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "review", "review-data.json");
const outputDir = path.join(root, "outputs", "name-accent-audit");
const outputName = process.argv[3] || "gold-review-500.xlsx";
const previewDir = process.argv[4]
  ? path.resolve(process.argv[4])
  : path.join(root, "review", "previews");
const payload = JSON.parse(await fs.readFile(dataPath, "utf8"));

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(previewDir, { recursive: true });

const workbook = Workbook.create();
const summary = workbook.worksheets.add("Сводка");
const review = workbook.worksheets.add("Проверка");
const guide = workbook.worksheets.add("Инструкция");

for (const sheet of [summary, review, guide]) sheet.showGridLines = false;

const red = "#E33D32";
const dark = "#1F2328";
const light = "#F4F5F7";
const paleRed = "#FCE8E6";
const paleGreen = "#E8F5E9";
const paleYellow = "#FFF6D6";
const muted = "#667085";

// Summary
summary.mergeCells("A1:F2");
summary.getRange("A1:F2").values = [[payload.title || "Проверка качества модели ударений"]];
summary.getRange("A1:F2").format = {
  fill: dark,
  font: { bold: true, color: "#FFFFFF", size: 18 },
  verticalAlignment: "center",
  horizontalAlignment: "left",
};
summary.getRange("A4:B8").values = [
  ["Показатель", "Значение"],
  ["Строк в очереди", payload.selected],
  ["Проверено экспертом", null],
  ["Осталось", null],
  ["Прогресс", null],
];
summary.getRange("B6").formulas = [[`=COUNTIF('Проверка'!$M$2:$M$${payload.selected + 1},"<>Не проверено")`]];
summary.getRange("B7").formulas = [["=B5-B6"]];
summary.getRange("B8").formulas = [["=IFERROR(B6/B5,0)"]];
summary.getRange("A4:B4").format = { fill: red, font: { bold: true, color: "#FFFFFF" } };
summary.getRange("B5:B7").format.numberFormat = "#,##0";
summary.getRange("B8").format.numberFormat = "0.0%";
summary.getRange("A4:B8").format.borders = { preset: "outside", style: "thin", color: "#D0D5DD" };

if (payload.model_label) {
  summary.getRange("D4:E8").values = [
    ["Эксперимент", "Значение"],
    ["Модель", payload.model_label],
    ["Метод выборки", payload.selection_method || ""],
    ["Совпали база и модель", payload.model_dataset_agreement],
    ["Доля совпадения", payload.model_dataset_agreement_rate],
  ];
  summary.getRange("D4:E4").format = { fill: red, font: { bold: true, color: "#FFFFFF" } };
  summary.getRange("D4:E8").format.borders = { preset: "outside", style: "thin", color: "#D0D5DD" };
  summary.getRange("E8").format.numberFormat = "0.0%";
  summary.getRange("E5:E7").format.wrapText = true;
}

const statuses = ["Не проверено", "Верна база", "Верна модель", "Исправлено вручную", "Не ФИО", "Не уверен"];
summary.getRange("A11:B17").values = [["Статус", "Количество"], ...statuses.map((status) => [status, null])];
for (let row = 12; row <= 17; row += 1) {
  summary.getRange(`B${row}`).formulas = [[`=COUNTIF('Проверка'!$M$2:$M$${payload.selected + 1},A${row})`]];
}
summary.getRange("A11:B11").format = { fill: dark, font: { bold: true, color: "#FFFFFF" } };
summary.getRange("A11:B17").format.borders = { preset: "outside", style: "thin", color: "#D0D5DD" };

const categories = Object.keys(payload.selected_categories);
summary.getRange(`D11:E${11 + categories.length}`).values = [
  ["Категория", "Количество"],
  ...categories.map((category) => [category, payload.selected_categories[category]]),
];
summary.getRange("D11:E11").format = { fill: dark, font: { bold: true, color: "#FFFFFF" } };
summary.getRange(`D11:E${11 + categories.length}`).format.borders = { preset: "outside", style: "thin", color: "#D0D5DD" };
summary.getRange("A20:F22").merge();
summary.getRange("A20:F22").values = [["Важно: dataset_output — это неподтверждённая разметка исходного файла. Она не считается правильной, пока эксперт не выберет статус и не заполнит результат при необходимости."]];
summary.getRange("A20:F22").format = { fill: paleYellow, font: { color: dark }, wrapText: true, verticalAlignment: "center" };
summary.getRange("A1:F22").format.font = { name: "Aptos", size: 11 };
summary.getRange("A1:F2").format.font = { name: "Aptos Display", bold: true, color: "#FFFFFF", size: 18 };
summary.getRange("A:A").format.columnWidth = 25;
summary.getRange("B:B").format.columnWidth = 15;
summary.getRange("C:C").format.columnWidth = 4;
summary.getRange("D:D").format.columnWidth = 24;
summary.getRange("E:E").format.columnWidth = 38;
summary.getRange("F:F").format.columnWidth = 4;
summary.getRange("5:5").format.rowHeight = 30;
summary.getRange("6:6").format.rowHeight = 44;
summary.freezePanes.freezeRows(2);

// Review queue
const headers = [
  "ID", "Приоритет", "Категория", "Причина проверки", "Исходная строка", "Очищенная строка",
  "Ответ базы", "Ответ модели", "Длина", "Ударений в базе", "Ударений модели",
  "Уверенность*", "Статус эксперта", "Правильный результат", "Комментарий",
];
headers.push("Источник", "Основание");
const rows = payload.rows.map((row) => [
  row.id,
  row.priority,
  row.category,
  row.review_reason,
  row.source_input,
  row.clean_input,
  row.dataset_output,
  row.model_output,
  row.length,
  row.dataset_stress_count,
  row.model_stress_count,
  row.model_confidence_heuristic,
  row.human_status,
  row.human_output,
  row.reviewer_notes,
  row.research_source_url || "",
  row.research_evidence || "",
]);
review.getRangeByIndexes(0, 0, rows.length + 1, headers.length).values = [headers, ...rows];
const table = review.tables.add(`A1:Q${rows.length + 1}`, true, "GoldReviewTable");
table.style = "TableStyleMedium2";
table.showBandedRows = true;
table.showFilterButton = true;
review.getRange("A1:Q1").format = { fill: red, font: { bold: true, color: "#FFFFFF" }, wrapText: true, verticalAlignment: "center" };
review.getRange(`L2:L${rows.length + 1}`).format.numberFormat = "0.0%";
review.getRange(`M2:M${rows.length + 1}`).dataValidation = { rule: { type: "list", values: statuses } };
review.getRange(`M2:M${rows.length + 1}`).conditionalFormats.add("containsText", { text: "Не проверено", format: { fill: paleYellow } });
review.getRange(`M2:M${rows.length + 1}`).conditionalFormats.add("containsText", { text: "Верна", format: { fill: paleGreen } });
review.getRange(`M2:M${rows.length + 1}`).conditionalFormats.add("containsText", { text: "Исправлено", format: { fill: paleGreen } });
review.getRange(`M2:M${rows.length + 1}`).conditionalFormats.add("containsText", { text: "Не ФИО", format: { fill: paleRed } });
review.getRange(`A2:A${rows.length + 1}`).format.font = { color: muted };
review.getRange(`F2:F${rows.length + 1}`).format.fill = "#F0F7FF";
review.getRange(`M2:O${rows.length + 1}`).format.fill = "#FFFDF2";
review.getRange(`A1:Q${rows.length + 1}`).format.font = { name: "Aptos", size: 10 };
review.getRange("A1:Q1").format.font = { name: "Aptos", size: 10, bold: true, color: "#FFFFFF" };
const widths = [12, 12, 22, 42, 24, 24, 24, 24, 9, 15, 17, 13, 22, 26, 36, 48, 52];
for (let index = 0; index < widths.length; index += 1) {
  review.getRangeByIndexes(0, index, rows.length + 1, 1).format.columnWidth = widths[index];
}
review.getRange(`D2:D${rows.length + 1}`).format.wrapText = true;
review.getRange(`O2:O${rows.length + 1}`).format.wrapText = true;
review.getRange(`P2:Q${rows.length + 1}`).format.wrapText = true;
review.getRange("1:1").format.rowHeight = 34;
review.freezePanes.freezeRows(1);
review.freezePanes.freezeColumns(5);

// Instructions
guide.mergeCells("A1:H2");
guide.getRange("A1:H2").values = [["Как проверять строки"]];
guide.getRange("A1:H2").format = { fill: dark, font: { name: "Aptos Display", bold: true, color: "#FFFFFF", size: 18 }, verticalAlignment: "center" };
const instructions = [
  ["Шаг", "Действие"],
  [1, "Посмотрите только на одну часть ФИО. Полное ФИО не требуется."],
  [2, "Если исходная строка содержит очевидную опечатку, исправьте поле «Очищенная строка». Редкое имя не исправляйте без уверенности."],
  [3, "Сравните «Ответ базы» и «Ответ модели». Оба варианта могут быть неправильными."],
  [4, "Выберите статус эксперта из выпадающего списка."],
  [5, "Если выбран статус «Исправлено вручную», заполните «Правильный результат» и поставьте + непосредственно перед ударной гласной."],
  [6, "Если это явно не часть ФИО или служебная информация, выберите «Не ФИО»."],
  [7, "Если определить ударение надёжно нельзя, выберите «Не уверен» — не угадывайте."],
];
guide.getRange("A4:B11").values = instructions;
guide.getRange("A4:B4").format = { fill: red, font: { bold: true, color: "#FFFFFF" } };
guide.getRange("A4:B11").format.borders = { preset: "outside", style: "thin", color: "#D0D5DD" };
guide.getRange("A5:A11").format.horizontalAlignment = "center";
guide.getRange("B5:B11").format.wrapText = true;
guide.getRange("A:A").format.columnWidth = 10;
guide.getRange("B:B").format.columnWidth = 95;
guide.getRange("A4:B11").format.rowHeight = 34;
guide.getRange("A13:H16").merge();
guide.getRange("A13:H16").values = [["* Уверенность модели — вспомогательный эвристический показатель, а не вероятность правильного ответа. Не используйте его как основание автоматически принять результат."]];
guide.getRange("A13:H16").format = { fill: paleYellow, wrapText: true, verticalAlignment: "center", font: { color: dark } };
guide.getRange("A1:H16").format.font = { name: "Aptos", size: 11 };
guide.getRange("A1:H2").format.font = { name: "Aptos Display", bold: true, color: "#FFFFFF", size: 18 };
guide.freezePanes.freezeRows(2);

const summaryInspect = await workbook.inspect({ kind: "table", sheetId: summary.name, range: "A1:F22", include: "values,formulas", tableMaxRows: 25, tableMaxCols: 8 });
console.log(summaryInspect.ndjson);
const reviewInspect = await workbook.inspect({ kind: "table", sheetId: review.name, range: "A1:Q8", include: "values,formulas", tableMaxRows: 8, tableMaxCols: 17 });
console.log(reviewInspect.ndjson);
const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: "formula error scan" });
console.log(errors.ndjson);

for (const [sheetName, range, fileName] of [
  ["Сводка", "A1:F22", "summary.png"],
  ["Проверка", "A1:Q25", "review.png"],
  ["Инструкция", "A1:H16", "guide.png"],
]) {
  const preview = await workbook.render({ sheetName, range, scale: 1.2, format: "png" });
  await fs.writeFile(path.join(previewDir, fileName), new Uint8Array(await preview.arrayBuffer()));
}

const output = await SpreadsheetFile.exportXlsx(workbook);
const outputPath = path.join(outputDir, outputName);
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, rows: rows.length }));
