import csv
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent / "names.csv"
REPORT = ROOT / "artifacts" / "names-gold-analysis.json"

VOWELS = set("аеёиоуыэюяәіүұө")
TOKEN_RE = re.compile(r"^[а-яёәғқңөұүһі]+(?:[-'][а-яёәғқңөұүһі]+)*$", re.IGNORECASE)


def norm(value: str) -> str:
    return unicodedata.normalize("NFC", value.strip().lower())


def valid_marks(value: str) -> bool:
    positions = [i for i, char in enumerate(value) if char == "+"]
    return 1 <= len(positions) <= 2 and all(i + 1 < len(value) and value[i + 1] in VOWELS for i in positions)


stats = Counter()
examples = defaultdict(list)
outputs_by_input = defaultdict(Counter)

with SOURCE.open("r", encoding="utf-8-sig", newline="") as handle:
    reader = csv.DictReader(handle, delimiter=";")
    stats["columns"] = len(reader.fieldnames or [])
    for row in reader:
        stats["rows"] += 1
        source = norm(row.get("gold_name", ""))
        output = norm(row.get("robot_name", ""))

        if "+" not in output:
            stats["without_plus"] += 1
            continue
        stats["with_plus"] += 1

        if not valid_marks(output):
            stats["invalid_plus_position_or_count"] += 1
            if len(examples["invalid_marks"]) < 20:
                examples["invalid_marks"].append([source, output])
            continue
        stats["valid_marks"] += 1

        plain_output = output.replace("+", "")
        if not source or not TOKEN_RE.fullmatch(source):
            stats["source_not_single_cyrillic_token"] += 1
            if len(examples["non_token"]) < 20:
                examples["non_token"].append([source, output])
            continue
        if not TOKEN_RE.fullmatch(plain_output):
            stats["output_not_single_cyrillic_token"] += 1
            continue
        if plain_output != source:
            stats["text_changed"] += 1
            if len(examples["text_changed"]) < 30:
                examples["text_changed"].append([source, output])
            continue
        if not 2 <= len(source) <= 40:
            stats["length_rejected"] += 1
            continue

        stats["strict_candidate_rows"] += 1
        outputs_by_input[source][output] += 1
        if len(examples["strict_candidates"]) < 30:
            examples["strict_candidates"].append([source, output])

conflicts = {}
unique_pairs = 0
repeat_rows = 0
for source, variants in outputs_by_input.items():
    unique_pairs += len(variants)
    repeat_rows += sum(variants.values()) - len(variants)
    if len(variants) > 1:
        conflicts[source] = dict(variants)

stats["unique_inputs_strict"] = len(outputs_by_input)
stats["unique_pairs_strict"] = unique_pairs
stats["duplicate_pair_rows"] = repeat_rows
stats["conflicting_inputs"] = len(conflicts)
stats["conflicting_rows"] = sum(sum(outputs_by_input[name].values()) for name in conflicts)
stats["conflict_free_inputs"] = len(outputs_by_input) - len(conflicts)

report = {
    "source": str(SOURCE),
    "selection_rule": {
        "source": "one Cyrillic token, optionally hyphenated",
        "output": "same token with 1-2 plus signs immediately before Cyrillic vowels",
        "normalization": "trim, lowercase, NFC",
        "conflicts": "all inputs having more than one accented output are excluded from gold",
    },
    "stats": dict(stats),
    "examples": dict(examples),
    "conflict_examples": dict(list(conflicts.items())[:50]),
}

REPORT.parent.mkdir(parents=True, exist_ok=True)
REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
