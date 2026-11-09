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
    parser = argparse.ArgumentParser(description="Predict stress for one already-cleaned FIO part.")
    parser.add_argument("text")
    parser.add_argument("--checkpoint", type=Path, default=Path("artifacts/best.pt"))
    parser.add_argument("--long-threshold", type=float, default=0.5)
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, char_to_id, _ = load_checkpoint(args.checkpoint, device)
    text = normalize_text(args.text)
    if not text or len(text) > model.config.max_length:
        raise SystemExit("Input is empty or longer than the model maximum.")

    ids = torch.tensor([[char_to_id.get(char, 1) for char in text]], dtype=torch.long, device=device)
    mask = torch.ones_like(ids, dtype=torch.bool)
    with torch.inference_mode():
        token_logits, count_logits = model(ids, mask)
        stress_count = predict_stress_count(count_logits[0].cpu(), text, args.long_threshold)
    print(render_stress(text, predict_positions(token_logits[0].cpu(), text, stress_count)))


if __name__ == "__main__":
    main()
