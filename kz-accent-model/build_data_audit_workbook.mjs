import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const payload = JSON.parse(await fs.readFile(path.join(root, "audit", "audit-data.json"), "utf8"));
const outputDir = path.join(root, "outputs", "name-accent-audit");
const previewDir = path.join(root, "audit", "previews");
await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(previewDir, { recursive: true });

const wb = Workbook.create();
const summary = wb.worksheets.add("Сводка аудита");
const overlaps = wb.worksheets.add("Пересечения");
const quarantine = wb.worksheets.add("Карантин");
const method = wb.worksheets.add("Методика");
for (const sheet of [summary, overlaps, quarantine, method]) sheet.showGridLines = false;

const red = "#E33D32";
const dark = "#1F2328";
const paleYellow = "#FFF6D6";
const paleGreen = "#E8F5E9";
const paleRed = "#FCE8E6";
const border = "#D0D5DD";

summary.mergeCells("A1:F2");
summary.getRange("A1:F2").values = [["Аудит обучающих данных"]];
summary.getRange("A1:F2").format = { fill: dark, font: { name: "Aptos Display", bold: true, color: "#FFFFFF", size: 18 }, verticalAlignment: "center" };
summary.getRange("A4:B12").values = [
  ["Показатель", "Значение"],
  ["Принято строк", payload.summary.accepted_rows],
  ["Эвристических корней", payload.summary.heuristic_root_groups],
  ["Корней в нескольких split", payload.summary.cross_split_root_groups],
  ["Test-строк с похожим корнем в train", payload.summary.test_rows_with_train_root],
  ["Доля пересечения test/train", payload.summary.test_root_overlap_rate],
  ["Validation-строк с похожим корнем в train", payload.summary.validation_rows_with_train_root],
  ["Доля пересечения validation/train", payload.summary.validation_root_overlap_rate],
  ["Кандидатов на карантин", payload.summary.quarantine_candidates_total],
];
summary.getRange("A4:B4").format = { fill: red, font: { bold: true, color: "#FFFFFF" } };
summary.getRange("A4:B12").format.borders = { preset: "outside", style: "thin", color: border };
summary.getRange("B5:B8").format.numberFormat = "#,##0";
summary.getRange("B9").format.numberFormat = "0.00%";
summary.getRange("B10").format.numberFormat = "#,##0";
summary.getRange("B11").format.numberFormat = "0.00%";
summary.getRange("B12").format.numberFormat = "#,##0";

summary.getRange("D4:E8").values = [
  ["Карантин: тип", "Количество"],
  ["Служебный маркер внутри", payload.summary.quarantine_candidate_counts.contains_service_marker ?? 0],
  ["Точное служебное слово", payload.summary.quarantine_candidate_counts.exact_service_word ?? 0],
  ["Один символ", payload.summary.quarantine_candidate_counts.single_character ?? 0],
  ["Три одинаковые буквы", payload.summary.quarantine_candidate_counts.three_repeated_characters ?? 0],
];
summary.getRange("D4:E4").format = { fill: dark, font: { bold: true, color: "#FFFFFF" } };
summary.getRange("D4:E8").format.borders = { preset: "outside", style: "thin", color: border };

summary.getRange("D10:E14").values = [
  ["Решение по карантину", "Количество"],
  ["Не проверено", null],
  ["Оставить", null],
  ["Исключить", null],
  ["Не уверен", null],
];
for (let row = 11; row <= 14; row += 1) {
  summary.getRange(`E${row}`).formulas = [[`=COUNTIF('Карантин'!$G$2:$G$${payload.quarantine_candidates.length + 1},D${row})`]];
}
summary.getRange("D10:E10").format = { fill: dark, font: { bold: true, color: "#FFFFFF" } };
summary.getRange("D10:E14").format.borders = { preset: "outside", style: "thin", color: border };

summary.mergeCells("A16:F19");
summary.getRange("A16:F19").values = [[payload.summary.method_note + " Поэтому исходные split и строки не изменены. Для честного теста нужно создать новое групповое разделение и обучить модель заново."]];
summary.getRange("A16:F19").format = { fill: paleYellow, wrapText: true, verticalAlignment: "center" };
summary.getRange("A:A").format.columnWidth = 42;
summary.getRange("B:B").format.columnWidth = 18;
summary.getRange("C:C").format.columnWidth = 4;
summary.getRange("D:D").format.columnWidth = 30;
summary.getRange("E:E").format.columnWidth = 16;
summary.getRange("F:F").format.columnWidth = 4;
summary.freezePanes.freezeRows(2);

const overlapHeaders = ["Корень (эвристика)", "Split", "Train", "Validation", "Test", "Примеры train", "Примеры validation", "Примеры test", "Удалённые окончания"];
const overlapRows = payload.cross_split_groups.map((row) => [row.root_key, row.splits, row.train_count, row.validation_count, row.test_count, row.train_examples, row.validation_examples, row.test_examples, row.stripped_suffixes]);
overlaps.getRangeByIndexes(0, 0, overlapRows.length + 1, overlapHeaders.length).values = [overlapHeaders, ...overlapRows];
const overlapTable = overlaps.tables.add(`A1:I${overlapRows.length + 1}`, true, "RootOverlapTable");
overlapTable.style = "TableStyleMedium2";
overlapTable.showFilterButton = true;
overlaps.getRange("A1:I1").format = { fill: red, font: { bold: true, color: "#FFFFFF" }, wrapText: true };
for (const [column, width] of [[0,22],[1,20],[2,10],[3,12],[4,10],[5,34],[6,34],[7,34],[8,26]]) {
  overlaps.getRangeByIndexes(0, column, overlapRows.length + 1, 1).format.columnWidth = width;
}
overlaps.getRange(`F2:I${overlapRows.length + 1}`).format.wrapText = true;
overlaps.freezePanes.freezeRows(1);
overlaps.freezePanes.freezeColumns(1);

const reasonLabels = {
  contains_service_marker: "Содержит служебный маркер",
  exact_service_word: "Точное служебное слово",
  single_character: "Один символ",
  three_repeated_characters: "Три одинаковые буквы",
};
const quarantineHeaders = ["Строка", "Разметка", "Split", "Причина", "Маркер", "Примечание системы", "Решение", "Комментарий эксперта"];
const quarantineRows = payload.quarantine_candidates.map((row) => [row.input, row.output, row.split, reasonLabels[row.reason] ?? row.reason, row.marker, row.decision, "Не проверено", ""]);
quarantine.getRangeByIndexes(0, 0, quarantineRows.length + 1, quarantineHeaders.length).values = [quarantineHeaders, ...quarantineRows];
const quarantineTable = quarantine.tables.add(`A1:H${quarantineRows.length + 1}`, true, "QuarantineCandidatesTable");
quarantineTable.style = "TableStyleMedium2";
quarantineTable.showFilterButton = true;
quarantine.getRange("A1:H1").format = { fill: red, font: { bold: true, color: "#FFFFFF" }, wrapText: true };
quarantine.getRange(`G2:G${quarantineRows.length + 1}`).dataValidation = { rule: { type: "list", values: ["Не проверено", "Оставить", "Исключить", "Не уверен"] } };
quarantine.getRange(`G2:G${quarantineRows.length + 1}`).conditionalFormats.add("containsText", { text: "Оставить", format: { fill: paleGreen } });
quarantine.getRange(`G2:G${quarantineRows.length + 1}`).conditionalFormats.add("containsText", { text: "Исключить", format: { fill: paleRed } });
quarantine.getRange(`G2:G${quarantineRows.length + 1}`).conditionalFormats.add("containsText", { text: "Не проверено", format: { fill: paleYellow } });
for (const [column, width] of [[0,28],[1,28],[2,12],[3,30],[4,20],[5,42],[6,18],[7,38]]) {
  quarantine.getRangeByIndexes(0, column, quarantineRows.length + 1, 1).format.columnWidth = width;
}
quarantine.getRange(`F2:H${quarantineRows.length + 1}`).format.wrapText = true;
quarantine.freezePanes.freezeRows(1);
quarantine.freezePanes.freezeColumns(2);

method.mergeCells("A1:H2");
method.getRange("A1:H2").values = [["Как читать аудит"]];
method.getRange("A1:H2").format = { fill: dark, font: { name: "Aptos Display", bold: true, color: "#FFFFFF", size: 18 }, verticalAlignment: "center" };
method.getRange("A4:B10").values = [
  ["Раздел", "Что означает"],
  ["Пересечения", "Из слова удаляется только известное фамильное или патронимическое окончание. Если полученный корень встречается в нескольких split, группа показана для проверки возможной утечки."],
  ["Не доказательство", "Одинаковый эвристический корень может случайно объединить разные имена. Эти строки нельзя удалять автоматически."],
  ["Карантин", "Только кандидаты на ручную проверку. Статус по умолчанию — «Не проверено»."],
  ["Оставить", "Строка является допустимой частью ФИО, даже если выглядит редко или необычно."],
  ["Исключить", "Выбирается только если на 100% видно, что это служебная информация или не часть ФИО."],
  ["Следующий тест", "Создать split по группам корней, затем заново обучить небольшую модель и сравнить с текущими 89,35%."],
];
method.getRange("A4:B4").format = { fill: red, font: { bold: true, color: "#FFFFFF" } };
method.getRange("A4:B10").format.borders = { preset: "outside", style: "thin", color: border };
method.getRange("B5:B10").format.wrapText = true;
method.getRange("A:A").format.columnWidth = 22;
method.getRange("B:B").format.columnWidth = 100;
method.getRange("A4:B10").format.rowHeight = 42;
method.freezePanes.freezeRows(2);

for (const sheet of [summary, overlaps, quarantine, method]) {
  const used = sheet.getUsedRange();
  used.format.font = { name: "Aptos", size: 10 };
}
summary.getRange("A1:F2").format.font = { name: "Aptos Display", bold: true, color: "#FFFFFF", size: 18 };
method.getRange("A1:H2").format.font = { name: "Aptos Display", bold: true, color: "#FFFFFF", size: 18 };

console.log((await wb.inspect({ kind: "table", sheetId: summary.name, range: "A1:F19", include: "values,formulas", tableMaxRows: 20, tableMaxCols: 8 })).ndjson);
console.log((await wb.inspect({ kind: "table", sheetId: overlaps.name, range: "A1:I6", include: "values", tableMaxRows: 6, tableMaxCols: 9 })).ndjson);
console.log((await wb.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: "formula error scan" })).ndjson);

for (const [sheetName, range, fileName] of [
  ["Сводка аудита", "A1:F19", "summary.png"],
  ["Пересечения", "A1:I22", "overlaps.png"],
  ["Карантин", "A1:H22", "quarantine.png"],
  ["Методика", "A1:H10", "method.png"],
]) {
  const preview = await wb.render({ sheetName, range, scale: 1.2, format: "png" });
  await fs.writeFile(path.join(previewDir, fileName), new Uint8Array(await preview.arrayBuffer()));
}

const out = await SpreadsheetFile.exportXlsx(wb);
const outputPath = path.join(outputDir, "training-data-audit.xlsx");
await out.save(outputPath);
console.log(JSON.stringify({ outputPath, overlapRows: overlapRows.length, quarantineRows: quarantineRows.length }));

