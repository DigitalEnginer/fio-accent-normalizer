from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from accent_data import AccentExample, iter_examples, render_stress
from grouped_split import root_key
from train import DEFAULT_CSV


SERVICE_MARKERS = (
    "родственник", "контакт", "комментар", "телефон", "номер", "клиент",
    "сестра", "брат", "мама", "папа", "супруг", "муж", "жена",
)
SERVICE_EXACT = frozenset({
    "имя", "фамилия", "отчество", "неизвестно", "нет", "контакт", "родственник",
    "телефон", "номер", "клиент", "мама", "папа", "брат", "сестра", "дочь",
    "сын", "муж", "жена",
})


def quarantine_reason(example: AccentExample) -> tuple[str, str] | None:
    text = example.text
    if text in SERVICE_EXACT:
        return "exact_service_word", text
    marker = next((value for value in SERVICE_MARKERS if value in text), None)
    if marker:
        return "contains_service_marker", marker
    if len(text) == 1:
        return "single_character", text
    repeated = re.search(r"(.)\1\1", text)
    if repeated:
        return "three_repeated_characters", repeated.group(0)
    return None


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Audit stress data without modifying or deleting source rows.")
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--output", type=Path, default=Path("audit/audit-data.json"))
    parser.add_argument("--max-group-samples", type=int, default=1000)
    parser.add_argument("--max-quarantine-samples", type=int, default=2000)
    args = parser.parse_args()

    groups: dict[str, dict] = {}
    split_totals: Counter[str] = Counter()
    suffix_counts: Counter[str] = Counter()
    quarantine_counts: Counter[str] = Counter()
    quarantine_rows: list[dict] = []

    for example in iter_examples(args.csv, max_length=32):
        split_totals[example.split] += 1
        key, stripped_suffix = root_key(example.text)
        if stripped_suffix:
            suffix_counts[stripped_suffix] += 1
        group = groups.setdefault(
            key,
            {"counts": Counter(), "examples": defaultdict(list), "suffixes": Counter()},
        )
        group["counts"][example.split] += 1
        if len(group["examples"][example.split]) < 3:
            group["examples"][example.split].append(example.text)
        if stripped_suffix:
            group["suffixes"][stripped_suffix] += 1

        quarantine = quarantine_reason(example)
        if quarantine:
            reason, marker = quarantine
            quarantine_counts[reason] += 1
            if len(quarantine_rows) < args.max_quarantine_samples:
                quarantine_rows.append({
                    "input": example.text,
                    "output": render_stress(example.text, example.stress_positions),
                    "split": example.split,
                    "reason": reason,
                    "marker": marker,
                    "decision": "Требует проверки — автоматически не удалять",
                })

    cross_groups = []
    test_rows_with_train_root = 0
    validation_rows_with_train_root = 0
    for key, group in groups.items():
        present = [split for split, count in group["counts"].items() if count]
        if "train" in present and "test" in present:
            test_rows_with_train_root += group["counts"]["test"]
        if "train" in present and "validation" in present:
            validation_rows_with_train_root += group["counts"]["validation"]
        if len(present) < 2:
            continue
        cross_groups.append({
            "root_key": key,
            "splits": ", ".join(sorted(present)),
            "train_count": group["counts"]["train"],
            "validation_count": group["counts"]["validation"],
            "test_count": group["counts"]["test"],
            "train_examples": ", ".join(group["examples"]["train"]),
            "validation_examples": ", ".join(group["examples"]["validation"]),
            "test_examples": ", ".join(group["examples"]["test"]),
            "stripped_suffixes": ", ".join(sorted(group["suffixes"])),
        })
    cross_groups.sort(
        key=lambda row: row["train_count"] + row["validation_count"] + row["test_count"],
        reverse=True,
    )

    summary = {
        "source": str(args.csv.resolve()),
        "method_note": "Эвристика удаляет только известные патронимические и фамильные окончания. Совпадение корня — сигнал возможной утечки, а не доказательство.",
        "accepted_rows": sum(split_totals.values()),
        "split_totals": dict(sorted(split_totals.items())),
        "heuristic_root_groups": len(groups),
        "cross_split_root_groups": len(cross_groups),
        "test_rows_with_train_root": test_rows_with_train_root,
        "test_root_overlap_rate": test_rows_with_train_root / split_totals["test"],
        "validation_rows_with_train_root": validation_rows_with_train_root,
        "validation_root_overlap_rate": validation_rows_with_train_root / split_totals["validation"],
        "quarantine_candidate_counts": dict(sorted(quarantine_counts.items())),
        "quarantine_candidates_total": sum(quarantine_counts.values()),
        "top_stripped_suffixes": suffix_counts.most_common(30),
    }
    payload = {
        "summary": summary,
        "cross_split_groups": cross_groups[: args.max_group_samples],
        "quarantine_candidates": quarantine_rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
