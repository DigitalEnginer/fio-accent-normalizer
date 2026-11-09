from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from accent_data import DOUBLE_STRESS_SUFFIXES, iter_examples, render_stress
from model import load_checkpoint
from train import DEFAULT_CSV, AccentDataset, predict_positions, predict_stress_count


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Report exact accuracy by stress-count and length groups.")
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--split", choices=("validation", "test"), default="test")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--long-threshold", type=float, default=0.5)
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, char_to_id, _ = load_checkpoint(args.checkpoint, device)
    examples = list(iter_examples(args.csv, split=args.split, max_length=model.config.max_length))
    loader = DataLoader(AccentDataset(examples, char_to_id, model.config.max_length), batch_size=256, shuffle=False)
    groups: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0])
    controls: list[dict[str, str]] = []
    long_rare_cases: list[dict[str, object]] = []
    offset = 0

    with torch.inference_mode():
        for input_ids, attention_mask, _, _ in loader:
            token_logits, count_logits = model(input_ids.to(device), attention_mask.to(device))
            count_logits = count_logits.cpu()
            batch_examples = examples[offset : offset + len(input_ids)]
            for logits, row_count_logits, example in zip(token_logits.cpu(), count_logits, batch_examples):
                predicted_count = predict_stress_count(row_count_logits, example.text, args.long_threshold)
                predicted = predict_positions(logits, example.text, predicted_count)
                correct = int(predicted == example.stress_positions)
                count_correct = int(predicted_count == len(example.stress_positions))
                names = ["all", f"stress_{len(example.stress_positions)}"]
                if len(example.text) >= 15:
                    names.append("length_15_plus")
                if len(example.stress_positions) == 2 and not example.text.endswith(DOUBLE_STRESS_SUFFIXES):
                    names.append("double_non_suffix")
                    if len(example.text) >= 15:
                        names.append("long_double_non_suffix")
                        long_rare_cases.append({
                            "input": example.text,
                            "expected": render_stress(example.text, example.stress_positions),
                            "predicted": render_stress(example.text, predicted),
                            "predicted_count": predicted_count,
                            "exact": bool(correct),
                        })
                        if correct and len(controls) < 5:
                            controls.append({"text": example.text, "positions": list(example.stress_positions)})
                for name in names:
                    groups[name][0] += correct
                    groups[name][1] += 1
                    groups[name][2] += count_correct
            offset += len(input_ids)

    report = {
        name: {
            "correct": correct,
            "total": total,
            "exact_accuracy": correct / total if total else 0.0,
            "count_correct": count_correct,
            "count_accuracy": count_correct / total if total else 0.0,
        }
        for name, (correct, total, count_correct) in sorted(groups.items())
    }
    payload = {
        "groups": report,
        "correct_long_double_examples": controls,
        "long_double_non_suffix_cases": long_rare_cases,
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
