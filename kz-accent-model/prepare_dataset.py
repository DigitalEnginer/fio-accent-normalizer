from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from accent_data import DataStats, iter_examples


DEFAULT_CSV = Path(__file__).resolve().parents[1] / "name-normalizer" / "web" / "data" / "finetuning" / "names-clean.csv"


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Validate multilingual FIO stress-only training rows.")
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--max-length", type=int, default=32)
    parser.add_argument("--report", type=Path, default=Path("artifacts/data-report.json"))
    args = parser.parse_args()

    stats = DataStats()
    split_counts: Counter[str] = Counter()
    stress_counts: Counter[int] = Counter()
    characters: set[str] = set()

    for example in iter_examples(args.csv, max_length=args.max_length, stats=stats):
        split_counts[example.split] += 1
        stress_counts[len(example.stress_positions)] += 1
        characters.update(example.text)

    report = {
        "source": str(args.csv.resolve()),
        "max_length": args.max_length,
        "stats": vars(stats),
        "accepted_by_split": dict(sorted(split_counts.items())),
        "stress_marks_per_word": {str(key): value for key, value in sorted(stress_counts.items())},
        "characters": "".join(sorted(characters)),
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
