import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function loadTypeScriptModule(relativePath, exportsList) {
  const source = await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const testModule = { exports: {} };
  vm.runInNewContext(compiled, { module: testModule, exports: testModule.exports, Set, Array });
  return Object.fromEntries(exportsList.map((name) => [name, testModule.exports[name]]));
}

const normalization = await loadTypeScriptModule("lib/normalization.ts", [
  "normalizeInput",
  "prepareInput",
]);
const validator = await loadTypeScriptModule("lib/result-validator.ts", [
  "validateModelResult",
]);
const russianRouting = await loadTypeScriptModule("lib/russian-name-routing.ts", [
  "isLikelyRussianNameForm",
]);
const unknownRescue = await loadTypeScriptModule("lib/unknown-rescue.ts", [
  "isPlausibleNamePartForRescue",
  "isPlausibleCyrillicNamePartForRescue",
]);
const spellingPolicy = await loadTypeScriptModule("lib/spelling-policy.ts", [
  "editDistance",
  "canApplyCorrection",
]);

test("normalizes case and outer whitespace", () => {
  assert.equal(normalization.normalizeInput("  ЖАНАТКАЛИЕВА  "), "жанаткалиева");
});

test("marks only deterministic garbage as UNKNOWN", () => {
  const excelError = normalization.prepareInput("#VALUE!");
  assert.equal(excelError.kind, "unknown");
  assert.equal(excelError.result, "UNKNOWN");

  const symbols = normalization.prepareInput("-----");
  assert.equal(symbols.kind, "unknown");
  assert.equal(symbols.result, "UNKNOWN");

  const lexicalNonName = normalization.prepareInput("есмь");
  assert.equal(lexicalNonName.kind, "processable");
  assert.equal(lexicalNonName.value, "есмь");

  const rareName = normalization.prepareInput("Қуаныш");
  assert.equal(rareName.kind, "processable");
  assert.equal(rareName.value, "қуаныш");
});

test("accepts instruction-compliant stress markers", () => {
  const surname = validator.validateModelResult("жанатк+алиева");
  assert.equal(surname.valid, true);
  assert.equal(surname.value, "жанатк+алиева");

  const patronymic = validator.validateModelResult("маметал+иұл+ы");
  assert.equal(patronymic.valid, true);
  assert.equal(patronymic.value, "маметал+иұл+ы");
});

test("rejects a marker before a consonant or an explanation", () => {
  assert.equal(validator.validateModelResult("а+бай").valid, false);
  assert.equal(validator.validateModelResult("Ответ: жанатк+алиева").valid, false);
});

test("accepts UNKNOWN exactly", () => {
  const result = validator.validateModelResult("UNKNOWN");
  assert.equal(result.valid, true);
  assert.equal(result.value, "UNKNOWN");
});

test("routes only confident Russian forms to RUAccent", () => {
  assert.equal(russianRouting.isLikelyRussianNameForm("наталья"), true);
  assert.equal(russianRouting.isLikelyRussianNameForm("иванов"), false);
  assert.equal(russianRouting.isLikelyRussianNameForm("сергеевич"), false);
  assert.equal(russianRouting.isLikelyRussianNameForm("абдикериова"), false);
  assert.equal(russianRouting.isLikelyRussianNameForm("цин"), false);
  assert.equal(russianRouting.isLikelyRussianNameForm("сахатбекқызы"), false);
  assert.equal(russianRouting.isLikelyRussianNameForm("анар"), false);
  assert.equal(russianRouting.isLikelyRussianNameForm("saydiganiyev"), false);
});

test("rescues plausible rare name parts without rescuing deterministic garbage", () => {
  assert.equal(unknownRescue.isPlausibleCyrillicNamePartForRescue("бешкемпір"), true);
  assert.equal(unknownRescue.isPlausibleCyrillicNamePartForRescue("покрава"), true);
  assert.equal(unknownRescue.isPlausibleNamePartForRescue("жан-пьер"), true);
  assert.equal(unknownRescue.isPlausibleNamePartForRescue("87051234567"), false);
  assert.equal(unknownRescue.isPlausibleNamePartForRescue("комментарий клиенту"), false);
  assert.equal(unknownRescue.isPlausibleNamePartForRescue("https://example.kz"), false);
  assert.equal(unknownRescue.isPlausibleNamePartForRescue("аааааа"), false);
});

test("applies every structured Cyrillic spelling correction", () => {
  assert.equal(spellingPolicy.editDistance("аблае", "аблай"), 1);
  assert.equal(
    spellingPolicy.canApplyCorrection("аблае", "аблай", "high"),
    true,
  );
  assert.equal(
    spellingPolicy.canApplyCorrection("калмуратрова", "калмуратова", "high"),
    true,
  );
  assert.equal(
    spellingPolicy.canApplyCorrection("сунетбай", "сүндетбай", "high"),
    true,
  );
  assert.equal(
    spellingPolicy.canApplyCorrection("аблае", "аблай", "low"),
    true,
  );
  assert.equal(
    spellingPolicy.canApplyCorrection("saydiganiyev", "сайдиганиев", "high"),
    true,
  );
  assert.equal(
    spellingPolicy.canApplyCorrection("saydiganiyev", "сайдиганиев", "low"),
    true,
  );
  assert.equal(
    spellingPolicy.canApplyCorrection("саңдк", "сағындық", "high"),
    true,
  );
  assert.equal(
    spellingPolicy.canApplyCorrection(";fyf", "жана", "high"),
    true,
  );
  assert.equal(
    spellingPolicy.canApplyCorrection("apple", "apple", "high"),
    false,
  );
});
