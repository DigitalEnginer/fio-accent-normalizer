from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch

from accent_data import normalize_text, render_stress
from model import load_checkpoint
from train import predict_positions, predict_stress_count


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Route short and long cleaned FIO parts to separate checkpoints.")
    parser.add_argument("text")
    parser.add_argument("--base", type=Path, default=Path("artifacts/laptop-300k-count-aware.pt"))
    parser.add_argument("--focused", type=Path, default=Path("artifacts/laptop-300k-focused-epoch2.pt"))
    parser.add_argument("--long-length", type=int, default=15)
    args = parser.parse_args()

    text = normalize_text(args.text)
    checkpoint = args.focused if len(text) >= args.long_length else args.base
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, char_to_id, _ = load_checkpoint(checkpoint, device)
    if not text or len(text) > model.config.max_length:
        raise SystemExit("Input is empty or longer than the model maximum.")
    ids = torch.tensor([[char_to_id.get(char, 1) for char in text]], dtype=torch.long, device=device)
    mask = torch.ones_like(ids, dtype=torch.bool)
    with torch.inference_mode():
        token_logits, count_logits = model(ids, mask)
        count = predict_stress_count(count_logits[0].cpu(), text)
    print(render_stress(text, predict_positions(token_logits[0].cpu(), text, count)))


if __name__ == "__main__":
    main()

