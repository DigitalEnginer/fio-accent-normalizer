from __future__ import annotations

import csv
import hashlib
import heapq
import json
import re
import sqlite3
from collections import Counter
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_CANDIDATES = (
    PROJECT_ROOT.parents[1] / "names.csv",
)
OUTPUT_DIR = PROJECT_ROOT / "data" / "finetuning"
REPORT_PATH = PROJECT_ROOT / "reports" / "finetuning-data.json"
STAGING_PATH = OUTPUT_DIR / "staging.sqlite"

VOWELS = set("аәеёиіоөуұүыэюя")
CYRILLIC_WORD = re.compile(r"^[а-яёәіңғүұқөһ]+$", re.IGNORECASE)
LATIN_WORD = re.compile(r"^[a-z]+$", re.IGNORECASE)
MARKED_WORD = re.compile(r"^[а-яёәіңғүұқөһ+]+$", re.IGNORECASE)

SPLIT_CATEGORY_LIMITS = {
    "train": {"accent_only": 16_000, "latin": 4_000},
    "validation": {"accent_only": 1_600, "latin": 400},
    "test": {"accent_only": 4_000, "latin": 1_000},
}
SYSTEM_MESSAGE = (
    "Нормализуй одну часть ФИО для Казахстана. Исправляй только очевидные ошибки, "
    "латиницу переводи в кириллицу, ставь + перед ударной гласной. Редкие имена "
    "не заменяй. Верни JSON только с полем result."
)


def marker_is_valid(value: str) -> bool:
    if not MARKED_WORD.fullmatch(value) or value.count("+") not in (1, 2):
        return False
    return all(
        position + 1 < len(value) and value[position + 1] in VOWELS
        for position, character in enumerate(value)
        if character == "+"
    )


def classify(source: str, expected: str) -> tuple[str | None, str]:
    source = source.strip().lower()
    expected = expected.strip().lower()

    if not source or not expected:
        return None, "empty"
    if len(source) > 60 or len(expected) > 80:
        return None, "too_long"
    if not marker_is_valid(expected):
        return None, "invalid_output"

    expected_base = expected.replace("+", "")
    if not CYRILLIC_WORD.fullmatch(expected_base):
        return None, "non_cyrillic_output"

    if CYRILLIC_WORD.fullmatch(source):
        if source != expected_base:
            return None, "unverified_correction"
        return "accent_only", "accepted"

    if LATIN_WORD.fullmatch(source):
        return "latin", "accepted"

    return None, "invalid_input"


def stable_score(value: str) -> int:
    return int.from_bytes(hashlib.sha256(value.encode("utf-8")).digest()[:8], "big")


def split_for(source: str) -> str:
    bucket = stable_score(source) % 100
    if bucket < 10:
        return "test"
    if bucket < 20:
        return "validation"
    return "train"


def add_to_reservoir(
    reservoirs: dict[tuple[str, str], list[tuple[int, str, str, str]]],
    split: str,
    source: str,
    expected: str,
    category: str,
) -> None:
    score = stable_score(f"pilot:{source}")
    item = (-score, source, expected, category)
    heap = reservoirs[(split, category)]
    limit = SPLIT_CATEGORY_LIMITS[split][category]
    if len(heap) < limit:
        heapq.heappush(heap, item)
    elif item > heap[0]:
        heapq.heapreplace(heap, item)


def training_record(source: str, expected: str) -> dict[str, object]:
    return {
        "messages": [
            {"role": "system", "content": SYSTEM_MESSAGE},
            {"role": "user", "content": source},
            {
                "role": "assistant",
                "content": json.dumps({"result": expected}, ensure_ascii=False),
            },
        ]
    }


def main() -> None:
    source_path = next((path for path in SOURCE_CANDIDATES if path.exists()), None)
    if source_path is None:
        raise FileNotFoundError(f"names.csv not found in {SOURCE_CANDIDATES}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(STAGING_PATH)
    connection.execute("DROP TABLE IF EXISTS candidates")
    connection.execute(
        """
        CREATE TABLE candidates (
            source TEXT PRIMARY KEY,
            expected TEXT NOT NULL,
            category TEXT NOT NULL,
            conflict INTEGER NOT NULL DEFAULT 0
        )
        """
    )

    counts: Counter[str] = Counter()
    with source_path.open("r", encoding="utf-8-sig", newline="") as source_file:
        reader = csv.DictReader(source_file, delimiter=";")
        for row in reader:
            counts["source_rows"] += 1
            source = (row.get("gold_name") or "").strip().lower()
            expected = (row.get("robot_name") or "").strip().lower()
            category, reason = classify(source, expected)
            counts[reason] += 1
            if category is None:
                continue

            existing = connection.execute(
                "SELECT expected FROM candidates WHERE source = ?", (source,)
            ).fetchone()
            if existing is None:
                connection.execute(
                    "INSERT INTO candidates(source, expected, category) VALUES (?, ?, ?)",
                    (source, expected, category),
                )
            elif existing[0] == expected:
                counts["duplicate_same"] += 1
            else:
                connection.execute(
                    "UPDATE candidates SET conflict = 1 WHERE source = ?", (source,)
                )
                counts["conflicting_labels"] += 1

            if counts["source_rows"] % 50_000 == 0:
                connection.commit()
    connection.commit()

    reservoirs: dict[tuple[str, str], list[tuple[int, str, str, str]]] = {
        (split, category): []
        for split, category_limits in SPLIT_CATEGORY_LIMITS.items()
        for category in category_limits
    }
    split_counts: Counter[str] = Counter()
    category_counts: Counter[str] = Counter()

    clean_csv_path = OUTPUT_DIR / "names-clean.csv"
    with clean_csv_path.open("w", encoding="utf-8-sig", newline="") as clean_file:
        writer = csv.writer(clean_file, delimiter=";")
        writer.writerow(["input", "output", "category", "split"])
        cursor = connection.execute(
            """
            SELECT source, expected, category
            FROM candidates
            WHERE conflict = 0
            ORDER BY source
            """
        )
        for source, expected, category in cursor:
            split = split_for(source)
            writer.writerow([source, expected, category, split])
            split_counts[split] += 1
            category_counts[category] += 1
            add_to_reservoir(reservoirs, split, source, expected, category)

    pilot_counts: dict[str, Counter[str]] = {}
    for split, category_limits in SPLIT_CATEGORY_LIMITS.items():
        rows = []
        for category in category_limits:
            rows.extend(reservoirs[(split, category)])
        rows.sort(key=lambda item: (-item[0], item[1]))
        pilot_counts[split] = Counter(row[3] for row in rows)
        jsonl_path = OUTPUT_DIR / f"{split}.jsonl"
        with jsonl_path.open("w", encoding="utf-8", newline="\n") as output_file:
            for _, source, expected, _ in rows:
                output_file.write(
                    json.dumps(training_record(source, expected), ensure_ascii=False)
                    + "\n"
                )

    counts["accepted_unique"] = sum(split_counts.values())
    counts["excluded_conflicted_sources"] = connection.execute(
        "SELECT COUNT(*) FROM candidates WHERE conflict = 1"
    ).fetchone()[0]
    connection.close()

    report = {
        "source": str(source_path),
        "policy": {
            "accepted": [
                "Cyrillic input where removing + from output gives the same text",
                "single-word Latin input with a valid single-word Cyrillic output",
            ],
            "excluded": [
                "all unverified spelling corrections",
                "technical garbage and multiword values",
                "invalid or inconsistent stress markers",
                "conflicting labels for the same normalized input",
            ],
        },
        "counts": dict(sorted(counts.items())),
        "clean_categories": dict(sorted(category_counts.items())),
        "clean_splits": dict(sorted(split_counts.items())),
        "pilot_limits": SPLIT_CATEGORY_LIMITS,
        "pilot_categories": {
            split: dict(sorted(values.items()))
            for split, values in pilot_counts.items()
        },
        "files": {
            "clean_csv": str(clean_csv_path),
            "train_jsonl": str(OUTPUT_DIR / "train.jsonl"),
            "validation_jsonl": str(OUTPUT_DIR / "validation.jsonl"),
            "test_jsonl": str(OUTPUT_DIR / "test.jsonl"),
        },
    }
    REPORT_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
