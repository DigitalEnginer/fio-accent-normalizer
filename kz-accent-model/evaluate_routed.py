from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from accent_data import iter_examples
from model import load_checkpoint
from train import DEFAULT_CSV, AccentDataset, evaluate


def evaluate_subset(checkpoint: Path, examples: list, device: torch.device) -> dict:
    model, char_to_id, _ = load_checkpoint(checkpoint, device)
    loader = DataLoader(AccentDataset(examples, char_to_id, model.config.max_length), batch_size=256, shuffle=False)
    return evaluate(model, loader, examples, device)


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Evaluate the validated short/long checkpoint router.")
    parser.add_argument("--base", type=Path, default=Path("artifacts/laptop-300k-count-aware.pt"))
    parser.add_argument("--focused", type=Path, default=Path("artifacts/laptop-300k-focused-epoch2.pt"))
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--split", choices=("validation", "test"), default="test")
    parser.add_argument("--long-length", type=int, default=15)
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    all_examples = list(iter_examples(args.csv, split=args.split, max_length=32))
    short = [example for example in all_examples if len(example.text) < args.long_length]
    long = [example for example in all_examples if len(example.text) >= args.long_length]
    short_metrics = evaluate_subset(args.base, short, device)
    long_metrics = evaluate_subset(args.focused, long, device)
    total = short_metrics["total"] + long_metrics["total"]
    exact = short_metrics["exact"] + long_metrics["exact"]
    payload = {
        "split": args.split,
        "router": {"shorter_than": args.long_length, "short_checkpoint": str(args.base), "long_checkpoint": str(args.focused)},
        "total": total,
        "exact": exact,
        "exact_accuracy": exact / total if total else 0.0,
        "short": {key: value for key, value in short_metrics.items() if key != "sample_errors"},
        "long": {key: value for key, value in long_metrics.items() if key != "sample_errors"},
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

