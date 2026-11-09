from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

from accent_data import iter_examples
from grouped_split import grouped_split_for, root_key
from train import DEFAULT_CSV


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Verify leakage-resistant grouped data assignment.")
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--group-seed", type=int, default=42)
    parser.add_argument("--max-length", type=int, default=32)
    parser.add_argument("--output", type=Path, default=Path("artifacts/grouped-split-report.json"))
    args = parser.parse_args()

    raw_counts: Counter[str] = Counter()
    unique_pairs: dict[str, set[tuple[str, tuple[int, ...]]]] = defaultdict(set)
    root_splits: dict[str, set[str]] = defaultdict(set)
    for example in iter_examples(args.csv, max_length=args.max_length):
        split = grouped_split_for(example.text, args.group_seed)
        raw_counts[split] += 1
        unique_pairs[split].add((example.text, example.stress_positions))
        root_splits[root_key(example.text)[0]].add(split)

    leaking_roots = sum(1 for splits in root_splits.values() if len(splits) > 1)
    unique_counts = {split: len(unique_pairs[split]) for split in ("train", "validation", "test")}
    total_unique = sum(unique_counts.values())
    report = {
        "group_seed": args.group_seed,
        "max_length": args.max_length,
        "raw_accepted_rows": dict(raw_counts),
        "unique_labeled_pairs": unique_counts,
        "unique_pair_rates": {
            split: unique_counts[split] / total_unique for split in unique_counts
        },
        "heuristic_root_groups": len(root_splits),
        "roots_present_in_multiple_splits": leaking_roots,
        "verified_no_cross_split_root_leakage": leaking_roots == 0,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
