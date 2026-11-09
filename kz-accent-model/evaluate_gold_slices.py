from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from accent_data import DOUBLE_STRESS_SUFFIXES, VOWELS, iter_examples, render_stress
from model import load_checkpoint
from train import AccentDataset, predict_positions, predict_stress_count

KAZAKH_LETTERS = set("әғқңөұүһі")


def group_names(text: str, expected_count: int) -> list[str]:
    names = ["overall"]
    names.append("kazakh_letters" if any(char in KAZAKH_LETTERS for char in text) else "common_cyrillic")
    names.append(f"stress_{expected_count}")
    length = len(text)
    names.append("length_2_7" if length <= 7 else "length_8_12" if length <= 12 else "length_13_20" if length <= 20 else "length_21_32")
    if length >= 15:
        names.append("long_15_plus")
    if text.endswith(DOUBLE_STRESS_SUFFIXES):
        names.append("known_double_suffix")
    if "-" in text:
        names.append("hyphenated")
    return names


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--split", default="test", choices=("validation", "test"))
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, char_to_id, metadata = load_checkpoint(args.checkpoint, device)
    examples = list(iter_examples(args.csv, split=args.split, max_length=model.config.max_length))
    loader = DataLoader(AccentDataset(examples, char_to_id, model.config.max_length), batch_size=256, shuffle=False)

    groups = defaultdict(lambda: Counter(total=0, exact=0, count_exact=0))
    confusion = Counter()
    error_samples = []
    model.eval()
    offset = 0
    with torch.inference_mode():
        for input_ids, attention_mask, _, stress_counts in loader:
            logits, count_logits = model(input_ids.to(device), attention_mask.to(device))
            logits = logits.cpu()
            count_logits = count_logits.cpu()
            batch_examples = examples[offset : offset + len(input_ids)]
            for row_logits, row_count_logits, expected_count_tensor, example in zip(logits, count_logits, stress_counts, batch_examples):
                expected_count = int(expected_count_tensor.item()) + 1
                predicted_count = predict_stress_count(row_count_logits, example.text)
                predicted = predict_positions(row_logits, example.text, predicted_count)
                is_exact = predicted == example.stress_positions
                confusion[(expected_count, predicted_count)] += 1
                for name in group_names(example.text, expected_count):
                    groups[name]["total"] += 1
                    groups[name]["exact"] += int(is_exact)
                    groups[name]["count_exact"] += int(predicted_count == expected_count)
                if not is_exact and len(error_samples) < 100:
                    error_samples.append({
                        "input": example.text,
                        "expected": render_stress(example.text, example.stress_positions),
                        "predicted": render_stress(example.text, predicted),
                        "expected_count": expected_count,
                        "predicted_count": predicted_count,
                    })
            offset += len(input_ids)

    metrics = {}
    for name, values in groups.items():
        total = values["total"]
        metrics[name] = {
            "total": total,
            "exact": values["exact"],
            "exact_accuracy": values["exact"] / total if total else 0.0,
            "count_accuracy": values["count_exact"] / total if total else 0.0,
        }

    payload = {
        "checkpoint": str(args.checkpoint.resolve()),
        "csv": str(args.csv.resolve()),
        "split": args.split,
        "device": str(device),
        "model_training_metadata": metadata,
        "metrics": metrics,
        "stress_count_confusion": {
            f"expected_{expected}_predicted_{predicted}": count
            for (expected, predicted), count in sorted(confusion.items())
        },
        "sample_errors": error_samples,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    compact = {name: value for name, value in metrics.items()}
    print(json.dumps({"metrics": compact, "stress_count_confusion": payload["stress_count_confusion"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
