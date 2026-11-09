from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

import torch

from accent_data import DOUBLE_STRESS_SUFFIXES, render_stress
from build_review_data import KAZAKH_CHARS, SERVICE_MARKERS, predict_examples
from grouped_split import iter_grouped_examples
from train import DEFAULT_CSV


def classify(text: str, stress_count: int) -> tuple[str, str, str]:
    service = next((marker for marker in SERVICE_MARKERS if marker in text), None)
    known_suffix = text.endswith(DOUBLE_STRESS_SUFFIXES)
    if service:
        return "service_candidate", "Высокий", f"Найден возможный служебный маркер: {service}"
    if len(text) >= 15 and stress_count == 2 and not known_suffix:
        return "long_double_other", "Высокий", "Длинная форма с двумя ударениями без известного суффикса"
    if len(text) >= 15:
        return "long_form", "Средний", "Длина 15 и более символов"
    if stress_count == 2 and not known_suffix:
        return "double_other", "Средний", "Два ударения без известного патронимического суффикса"
    if stress_count == 2 and known_suffix:
        return "double_suffix", "Средний", "Два ударения с патронимическим суффиксом"
    if any(char in KAZAKH_CHARS for char in text):
        return "kazakh_letters", "Обычный", "Содержит специфические казахские буквы"
    return "general", "Обычный", "Случайная строка из честного grouped-test"


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Build an unbiased grouped-test human review sample.")
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--checkpoint", type=Path, default=Path("artifacts/grouped-300k.pt"))
    parser.add_argument("--size", type=int, default=500)
    parser.add_argument("--seed", type=int, default=20260807)
    parser.add_argument("--group-seed", type=int, default=42)
    parser.add_argument("--output", type=Path, default=Path("review/grouped-review-data.json"))
    args = parser.parse_args()

    population = list(iter_grouped_examples(args.csv, "test", max_length=32, seed=args.group_seed))
    if args.size > len(population):
        raise ValueError(f"Requested {args.size} rows from a population of {len(population)}.")
    sampled = random.Random(args.seed).sample(population, args.size)
    predictions = predict_examples(args.checkpoint, sampled, torch.device("cuda" if torch.cuda.is_available() else "cpu"))

    rows: list[dict] = []
    agreement = 0
    for index, prediction in enumerate(predictions, start=1):
        example = prediction["example"]
        category, priority, reason = classify(example.text, len(example.stress_positions))
        matches = prediction["positions"] == example.stress_positions
        agreement += int(matches)
        rows.append({
            "id": f"GOLD-{index:04d}",
            "priority": priority,
            "category": category,
            "review_reason": reason,
            "source_input": example.text,
            "clean_input": example.text,
            "dataset_output": render_stress(example.text, example.stress_positions),
            "model_output": prediction["output"],
            "length": len(example.text),
            "dataset_stress_count": len(example.stress_positions),
            "model_stress_count": prediction["predicted_count"],
            "has_kazakh_letters": any(char in KAZAKH_CHARS for char in example.text),
            "service_candidate": category == "service_candidate",
            "model_confidence_heuristic": prediction["confidence"],
            "human_status": "Не проверено",
            "human_output": "",
            "reviewer_notes": "",
        })

    payload = {
        "title": "Честная проверка grouped-300k",
        "source": str(args.csv.resolve()),
        "model_label": "grouped-300k, эпоха 4",
        "checkpoint": str(args.checkpoint),
        "selection_method": "Равномерная случайная выборка из grouped-test",
        "sample_seed": args.seed,
        "group_seed": args.group_seed,
        "test_examples": len(population),
        "selected": len(rows),
        "model_dataset_agreement": agreement,
        "model_dataset_agreement_rate": agreement / len(rows),
        "selected_categories": dict(sorted(Counter(row["category"] for row in rows).items())),
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in payload.items() if key != "rows"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
