from __future__ import annotations

import csv
import hashlib
import heapq
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

from grouped_split import grouped_split_for

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent / "names.csv"
OUTPUT_DIR = ROOT / "outputs" / "name-gold"
OUTPUT_CSV = OUTPUT_DIR / "gold-from-names.csv"
REPORT_JSON = OUTPUT_DIR / "gold-from-names-report.json"
SAMPLES_JSON = OUTPUT_DIR / "gold-from-names-samples.json"

VOWELS = set("аеёиоуыэюяәіүұө")
TOKEN_RE = re.compile(r"^[а-яёәғқңөұүһі]+(?:[-'][а-яёәғқңөұүһі]+)*$", re.IGNORECASE)
KAZAKH_LETTERS = set("әғқңөұүһі")
SAMPLE_LIMIT_PER_SPLIT = 200


def norm(value: str) -> str:
    return unicodedata.normalize("NFC", value.strip().lower())


def valid_marks(value: str) -> bool:
    positions = [i for i, char in enumerate(value) if char == "+"]
    return 1 <= len(positions) <= 2 and all(i + 1 < len(value) and value[i + 1] in VOWELS for i in positions)


def stable_score(value: str) -> int:
    return int.from_bytes(hashlib.sha256(value.encode("utf-8")).digest()[:8], "big")


def add_sample(reservoirs: dict[str, list[tuple[int, dict]]], split: str, row: dict) -> None:
    score = stable_score(f"gold-sample:{row['input']}")
    item = (-score, row)
    heap = reservoirs[split]
    if len(heap) < SAMPLE_LIMIT_PER_SPLIT:
        heapq.heappush(heap, item)
    elif item > heap[0]:
        heapq.heapreplace(heap, item)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    counts: Counter[str] = Counter()
    labels: dict[str, str] = {}
    conflicts: set[str] = set()

    with SOURCE.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        for row in reader:
            counts["source_rows"] += 1
            source = norm(row.get("gold_name", ""))
            output = norm(row.get("robot_name", ""))
            if not source or not output:
                counts["excluded_empty"] += 1
                continue
            if not valid_marks(output):
                counts["excluded_invalid_stress"] += 1
                continue
            plain_output = output.replace("+", "")
            if not TOKEN_RE.fullmatch(source) or not TOKEN_RE.fullmatch(plain_output):
                counts["excluded_not_single_cyrillic_token"] += 1
                continue
            if plain_output != source:
                counts["excluded_text_changed"] += 1
                continue
            if not 2 <= len(source) <= 40:
                counts["excluded_length"] += 1
                continue

            previous = labels.get(source)
            if previous is None:
                labels[source] = output
            elif previous == output:
                counts["duplicate_same"] += 1
            else:
                conflicts.add(source)
                counts["conflicting_rows"] += 1

    for source in conflicts:
        labels.pop(source, None)

    split_counts: Counter[str] = Counter()
    stress_counts: Counter[int] = Counter()
    kazakh_counts: Counter[str] = Counter()
    length_bands: Counter[str] = Counter()
    reservoirs: dict[str, list[tuple[int, dict]]] = defaultdict(list)

    with OUTPUT_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle, delimiter=";")
        writer.writerow(["input", "output", "split"])
        for source in sorted(labels):
            output = labels[source]
            split = grouped_split_for(source, seed=42)
            writer.writerow([source, output, split])
            split_counts[split] += 1
            stress_counts[output.count("+")] += 1
            kazakh_counts["contains_kazakh_letters" if any(c in KAZAKH_LETTERS for c in source) else "common_cyrillic_only"] += 1
            length = len(source)
            band = "2-7" if length <= 7 else "8-12" if length <= 12 else "13-20" if length <= 20 else "21-40"
            length_bands[band] += 1
            add_sample(reservoirs, split, {
                "input": source,
                "output": output,
                "split": split,
                "stress_count": output.count("+"),
                "length": length,
                "has_kazakh_letters": any(c in KAZAKH_LETTERS for c in source),
            })

    samples = []
    for split in ("train", "validation", "test"):
        samples.extend(row for _, row in sorted(reservoirs[split], key=lambda item: (-item[0], item[1]["input"])))

    accepted = len(labels)
    counts["accepted_unique"] = accepted
    counts["excluded_conflicting_inputs"] = len(conflicts)
    counts["excluded_total"] = counts["source_rows"] - accepted - counts["duplicate_same"]

    report = {
        "title": "Gold-база из names.csv — строгий слой",
        "source": str(SOURCE),
        "output_csv": str(OUTPUT_CSV),
        "policy": [
            "Одна кириллическая часть ФИО; допускаются дефис и апостроф",
            "После удаления + результат полностью совпадает с исходной строкой",
            "Один или два знака + стоят непосредственно перед гласной",
            "Дубликаты объединяются, конфликтующие варианты исключаются",
            "Разбиение train/validation/test выполняется по корню имени с seed=42",
        ],
        "limitations": [
            "Это разметка из names.csv, а не независимая ручная экспертная проверка",
            "Однословный формат не гарантирует, что каждая строка действительно является частью ФИО",
            "Нельзя использовать строки, попавшие в обучение, для независимой оценки уже обученной модели",
        ],
        "counts": dict(counts),
        "splits": dict(split_counts),
        "stress_marks": {str(key): value for key, value in sorted(stress_counts.items())},
        "script_groups": dict(kazakh_counts),
        "length_bands": dict(length_bands),
        "sample_rows": len(samples),
    }
    REPORT_JSON.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    SAMPLES_JSON.write_text(json.dumps(samples, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
