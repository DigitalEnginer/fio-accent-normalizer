from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from accent_data import DOUBLE_STRESS_SUFFIXES, iter_examples
from model import load_checkpoint
from train import DEFAULT_CSV, AccentDataset, predict_positions


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Tune long-word two-stress threshold on validation only.")
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--output", type=Path, default=Path("artifacts/long-threshold.json"))
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, char_to_id, _ = load_checkpoint(args.checkpoint, device)
    examples = [
        example
        for example in iter_examples(args.csv, split="validation", max_length=model.config.max_length)
        if len(example.text) >= 15 and not example.text.endswith(DOUBLE_STRESS_SUFFIXES)
    ]
    loader = DataLoader(AccentDataset(examples, char_to_id, model.config.max_length), batch_size=256, shuffle=False)
    cached: list[tuple[torch.Tensor, float, object]] = []
    offset = 0
    with torch.inference_mode():
        for input_ids, attention_mask, _, _ in loader:
            token_logits, count_logits = model(input_ids.to(device), attention_mask.to(device))
            probabilities = count_logits.softmax(dim=-1)[:, 1].cpu()
            batch_examples = examples[offset : offset + len(input_ids)]
            cached.extend(zip(token_logits.cpu(), probabilities.tolist(), batch_examples))
            offset += len(input_ids)

    candidates = [round(value / 100, 2) for value in range(5, 51, 5)]
    results = []
    for threshold in candidates:
        exact = 0
        count_correct = 0
        for logits, probability_two, example in cached:
            count = 2 if probability_two >= threshold else 1
            predicted = predict_positions(logits, example.text, count)
            exact += int(predicted == example.stress_positions)
            count_correct += int(count == len(example.stress_positions))
        results.append({
            "threshold": threshold,
            "total": len(cached),
            "exact": exact,
            "exact_accuracy": exact / len(cached) if cached else 0.0,
            "count_accuracy": count_correct / len(cached) if cached else 0.0,
        })

    best = max(results, key=lambda item: (item["exact_accuracy"], item["count_accuracy"]))
    payload = {"checkpoint": str(args.checkpoint), "best": best, "candidates": results}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
