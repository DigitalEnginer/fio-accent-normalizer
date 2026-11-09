from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from model import load_checkpoint
from train import DEFAULT_CSV, AccentDataset, evaluate, reservoir_sample


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Evaluate a checkpoint on an untouched CSV split.")
    parser.add_argument("--checkpoint", type=Path, default=Path("artifacts/best.pt"))
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--split", choices=("validation", "test"), default="test")
    parser.add_argument("--limit", type=int, default=10_000)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--split-strategy", choices=("original", "grouped"), default="original")
    parser.add_argument("--group-seed", type=int, default=42)
    parser.add_argument("--output", type=Path, help="Optional JSON report path.")
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, char_to_id, metadata = load_checkpoint(args.checkpoint, device)
    examples = reservoir_sample(
        args.csv, args.split, args.limit, model.config.max_length, args.seed,
        args.split_strategy, args.group_seed,
    )
    loader = DataLoader(
        AccentDataset(examples, char_to_id, model.config.max_length),
        batch_size=256,
        shuffle=False,
    )
    metrics = evaluate(model, loader, examples, device)
    metrics.update({
        "split": args.split,
        "split_strategy": args.split_strategy,
        "group_seed": args.group_seed,
        "checkpoint": str(args.checkpoint),
        "training_metadata": metadata,
    })
    payload = json.dumps(metrics, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8")
    print(payload)


if __name__ == "__main__":
    main()
