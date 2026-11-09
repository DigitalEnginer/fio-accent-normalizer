from __future__ import annotations

import concurrent.futures
import argparse
import csv
import json
import random
import re
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_CANDIDATES = (
    PROJECT_ROOT.parents[1] / "names.csv",
)
SAMPLE_PATH = PROJECT_ROOT / "data" / "eval" / "sample-50.json"
REPORT_PATH = PROJECT_ROOT / "reports" / "evaluation-50.json"
API_URL = "http://localhost:3000/api/normalize"
RANDOM_SEED = 20260806

VOWELS = set("аәеёиіоөуұүыэюяaeiouy")
CYRILLIC_ONLY = re.compile(r"^[а-яёәіңғүұқөһ]+$", re.IGNORECASE)
LATIN_ONLY = re.compile(r"^[a-z]+$", re.IGNORECASE)
VALID_RESULT = re.compile(r"^[^\W\d_+]+(?:\+[^\W\d_+]+)+(?:[-'’][^\W\d_+]+)*$", re.UNICODE)
RUSSIAN_SUFFIXES = (
    "ов",
    "ев",
    "ова",
    "ева",
    "ин",
    "ина",
    "ич",
    "ович",
    "евич",
    "евна",
    "овна",
)
DOUBLE_STRESS_SUFFIXES = ("ұлы", "улы", "қызы", "кызы")
CONTROL_INPUTS = {
    "жанаткалиева",
    "жумахан",
    "нурлан",
    "жумаханов",
    "нурлановна",
    "жанибек",
    "сагинбаевна",
    "маметалиұлы",
    "мадетханқызы",
}

CATEGORY_LIMITS = {
    "accent_only": 10,
    "latin": 10,
    "correction": 15,
    "uly_kyzy": 10,
    "russian_suffix": 5,
}


def marker_is_valid(value: str) -> bool:
    if not VALID_RESULT.fullmatch(value):
        return False
    for position, character in enumerate(value):
        if character == "+":
            if position + 1 >= len(value) or value[position + 1] not in VOWELS:
                return False
    return True


def reservoir_add(
    reservoirs: dict[str, list[dict[str, str]]],
    seen: dict[str, int],
    category: str,
    item: dict[str, str],
    rng: random.Random,
) -> None:
    seen[category] += 1
    limit = CATEGORY_LIMITS[category]
    if len(reservoirs[category]) < limit:
        reservoirs[category].append(item)
        return
    replacement = rng.randrange(seen[category])
    if replacement < limit:
        reservoirs[category][replacement] = item


def classify(source: str, expected: str) -> str | None:
    source_lower = source.strip().lower()
    expected_lower = expected.strip().lower()
    expected_base = expected_lower.replace("+", "")

    if (
        not source_lower
        or len(source_lower) > 60
        or source_lower in CONTROL_INPUTS
        or " " in source_lower
        or " " in expected_lower
        or not marker_is_valid(expected_lower)
    ):
        return None

    if expected_base.endswith(DOUBLE_STRESS_SUFFIXES) and expected_lower.count("+") == 2:
        return "uly_kyzy"

    if (
        expected_base.endswith(RUSSIAN_SUFFIXES)
        and expected_lower.count("+") == 1
        and CYRILLIC_ONLY.fullmatch(source_lower)
        and source_lower == expected_base
    ):
        return "russian_suffix"

    if LATIN_ONLY.fullmatch(source_lower) and CYRILLIC_ONLY.fullmatch(expected_base):
        return "latin"

    if CYRILLIC_ONLY.fullmatch(source_lower) and source_lower == expected_base:
        return "accent_only"

    if (
        CYRILLIC_ONLY.fullmatch(expected_base)
        and source_lower != expected_base
        and any(character.isalpha() for character in source_lower)
        and not any(character.isdigit() for character in source_lower)
    ):
        return "correction"

    return None


def prepare_sample() -> list[dict[str, str]]:
    source_csv = next((path for path in SOURCE_CANDIDATES if path.exists()), None)
    if source_csv is None:
        raise FileNotFoundError(f"Source CSV not found: {SOURCE_CANDIDATES}")

    rng = random.Random(RANDOM_SEED)
    reservoirs: dict[str, list[dict[str, str]]] = defaultdict(list)
    seen: dict[str, int] = defaultdict(int)

    with source_csv.open("r", encoding="utf-8-sig", newline="") as source_file:
        reader = csv.DictReader(source_file, delimiter=";")
        for row in reader:
            source = row["gold_name"]
            expected = row["robot_name"].strip().lower()
            category = classify(source, expected)
            if category is None:
                continue
            reservoir_add(
                reservoirs,
                seen,
                category,
                {"category": category, "input": source, "expected": expected},
                rng,
            )

    sample = [item for category in CATEGORY_LIMITS for item in reservoirs[category]]
    missing = {
        category: CATEGORY_LIMITS[category] - len(reservoirs[category])
        for category in CATEGORY_LIMITS
        if len(reservoirs[category]) != CATEGORY_LIMITS[category]
    }
    if missing:
        raise RuntimeError(f"Insufficient clean samples: {missing}")

    SAMPLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    SAMPLE_PATH.write_text(
        json.dumps(sample, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return sample


def call_api(item: dict[str, str]) -> dict[str, object]:
    request_body = json.dumps(
        {"value": item["input"], "recordHistory": False}, ensure_ascii=True
    ).encode("ascii")

    last_error = ""
    started = time.perf_counter()
    for attempt in range(3):
        request = urllib.request.Request(
            API_URL,
            data=request_body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8"))
            actual = payload.get("result", "")
            expected = item["expected"]
            return {
                **item,
                "actual": actual,
                "exact_match": actual == expected,
                "text_match": actual.replace("+", "") == expected.replace("+", ""),
                "latency_ms": round((time.perf_counter() - started) * 1000),
                "error": None,
            }
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = str(error)
            if attempt < 2:
                time.sleep(2**attempt)

    return {
        **item,
        "actual": "",
        "exact_match": False,
        "text_match": False,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "error": last_error,
    }


def summarize(results: list[dict[str, object]]) -> dict[str, object]:
    category_summary: dict[str, dict[str, object]] = {}
    for category in CATEGORY_LIMITS:
        rows = [row for row in results if row["category"] == category]
        category_summary[category] = {
            "count": len(rows),
            "exact_matches": sum(bool(row["exact_match"]) for row in rows),
            "text_matches": sum(bool(row["text_match"]) for row in rows),
            "errors": sum(bool(row["error"]) for row in rows),
        }

    latencies = [int(row["latency_ms"]) for row in results]
    return {
        "sample_size": len(results),
        "exact_matches": sum(bool(row["exact_match"]) for row in results),
        "text_matches": sum(bool(row["text_match"]) for row in results),
        "errors": sum(bool(row["error"]) for row in results),
        "average_latency_ms": round(sum(latencies) / len(latencies)),
        "categories": category_summary,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--category",
        choices=tuple(CATEGORY_LIMITS),
        help="Run only one category from the deterministic sample.",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=REPORT_PATH,
        help="Output report path, relative to the project root unless absolute.",
    )
    args = parser.parse_args()

    sample = prepare_sample()
    if args.category:
        sample = [item for item in sample if item["category"] == args.category]

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        results = list(executor.map(call_api, sample))

    report = {"summary": summarize(results), "results": results}
    report_path = args.report
    if not report_path.is_absolute():
        report_path = PROJECT_ROOT / report_path
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report["summary"], ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
