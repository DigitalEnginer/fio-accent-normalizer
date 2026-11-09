from __future__ import annotations

import argparse
import json
import random
import sys
import time
from dataclasses import asdict
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

from accent_data import DOUBLE_STRESS_SUFFIXES, AccentExample, VOWELS, collect_characters, iter_examples, render_stress
from grouped_split import iter_grouped_examples
from model import PAD_TOKEN, UNK_TOKEN, AccentTransformer, ModelConfig, load_checkpoint, save_checkpoint


DEFAULT_CSV = Path(__file__).resolve().parents[1] / "name-normalizer" / "web" / "data" / "finetuning" / "names-clean.csv"
PROFILES = {
    "smoke": {"d_model": 64, "nhead": 4, "num_layers": 1, "dim_feedforward": 128, "batch_size": 128},
    "laptop": {"d_model": 96, "nhead": 4, "num_layers": 2, "dim_feedforward": 192, "batch_size": 256},
    "ruaccent-like": {"d_model": 128, "nhead": 8, "num_layers": 4, "dim_feedforward": 256, "batch_size": 256},
}


class AccentDataset(Dataset):
    def __init__(self, examples: list[AccentExample], char_to_id: dict[str, int], max_length: int) -> None:
        self.examples = examples
        self.char_to_id = char_to_id
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.examples)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        example = self.examples[index]
        ids = [self.char_to_id.get(char, 1) for char in example.text]
        # Consonants can never receive stress, so they are excluded from the
        # loss. The model learns the actual decision: which vowel(s) are stressed.
        labels = [
            (1 if pos in example.stress_positions else 0) if char in VOWELS else -100
            for pos, char in enumerate(example.text)
        ]
        padding = self.max_length - len(ids)
        return (
            torch.tensor(ids + [0] * padding, dtype=torch.long),
            torch.tensor([1] * len(ids) + [0] * padding, dtype=torch.bool),
            torch.tensor(labels + [-100] * padding, dtype=torch.long),
            torch.tensor(min(2, len(example.stress_positions)) - 1, dtype=torch.long),
        )


def reservoir_sample(
    path: Path,
    split: str,
    limit: int | None,
    max_length: int,
    seed: int,
    split_strategy: str = "original",
    group_seed: int = 42,
) -> list[AccentExample]:
    """Take a deterministic uniform sample instead of an alphabetic prefix."""
    if split_strategy not in {"original", "grouped"}:
        raise ValueError(f"Unknown split strategy: {split_strategy}")
    source = (
        iter_examples(path, split=split, max_length=max_length)
        if split_strategy == "original"
        else iter_grouped_examples(path, split=split, max_length=max_length, seed=group_seed)
    )
    if limit is None:
        return list(source)
    rng = random.Random(seed)
    sample: list[AccentExample] = []
    for seen, example in enumerate(source, start=1):
        if len(sample) < limit:
            sample.append(example)
            continue
        replacement = rng.randrange(seen)
        if replacement < limit:
            sample[replacement] = example
    rng.shuffle(sample)
    return sample


def reservoir_original_splits_once(
    path: Path,
    train_limit: int | None,
    validation_limit: int | None,
    max_length: int,
    seed: int,
) -> tuple[list[AccentExample], list[AccentExample]]:
    """Collect original train and validation reservoirs in one CSV pass."""
    limits = {"train": train_limit, "validation": validation_limit}
    samples: dict[str, list[AccentExample]] = {"train": [], "validation": []}
    seen = {"train": 0, "validation": 0}
    rngs = {"train": random.Random(seed), "validation": random.Random(seed + 1)}

    for example in iter_examples(path, max_length=max_length):
        split = example.split
        if split not in samples:
            continue
        seen[split] += 1
        limit = limits[split]
        sample = samples[split]
        if limit is None or len(sample) < limit:
            sample.append(example)
            continue
        replacement = rngs[split].randrange(seen[split])
        if replacement < limit:
            sample[replacement] = example

    rngs["train"].shuffle(samples["train"])
    rngs["validation"].shuffle(samples["validation"])
    return samples["train"], samples["validation"]


def build_focused_training_set(
    path: Path,
    base_limit: int,
    max_length: int,
    seed: int,
) -> tuple[list[AccentExample], dict[str, int]]:
    """Mix broad coverage with rare double-stress cases and hard negatives."""
    base = reservoir_sample(path, "train", base_limit, max_length, seed)
    double_non_suffix: list[AccentExample] = []
    long_double_non_suffix: list[AccentExample] = []
    long_single: list[AccentExample] = []
    for example in iter_examples(path, split="train", max_length=max_length):
        if len(example.stress_positions) == 2 and not example.text.endswith(DOUBLE_STRESS_SUFFIXES):
            double_non_suffix.append(example)
            if len(example.text) >= 15:
                long_double_non_suffix.append(example)
        elif len(example.stress_positions) == 1 and len(example.text) >= 15:
            long_single.append(example)

    # All rare positives are included twice. The rarest long compound positives
    # receive additional repeats, while long one-stress forms prevent the model
    # from learning the unsafe shortcut "long word => two stresses".
    focused = (
        base
        + double_non_suffix * 2
        + long_double_non_suffix * 10
        + long_single * 2
    )
    random.Random(seed + 17).shuffle(focused)
    stats = {
        "base": len(base),
        "double_non_suffix_unique": len(double_non_suffix),
        "long_double_non_suffix_unique": len(long_double_non_suffix),
        "long_single_unique": len(long_single),
        "focused_total_with_repeats": len(focused),
    }
    return focused, stats


def predict_positions(logits: torch.Tensor, text: str, stress_count: int) -> tuple[int, ...]:
    probabilities = logits.softmax(dim=-1)[: len(text), 1]
    vowel_indexes = [index for index, char in enumerate(text) if char in VOWELS]
    if not vowel_indexes:
        return ()
    suffix = next((value for value in DOUBLE_STRESS_SUFFIXES if text.endswith(value)), None)
    if suffix is not None:
        suffix_start = len(text) - len(suffix)
        suffix_vowels = [index for index in vowel_indexes if index >= suffix_start]
        stem_vowels = [index for index in vowel_indexes if index < suffix_start]
        if suffix_vowels and stem_vowels:
            # The patronymic suffix carries its own final-vowel stress. The
            # neural model chooses the independent stress in the stem.
            suffix_position = suffix_vowels[-1]
            stem_position = max(stem_vowels, key=lambda index: probabilities[index].item())
            return tuple(sorted((stem_position, suffix_position)))
    required = max(1, min(stress_count, len(vowel_indexes)))
    selected = sorted(vowel_indexes, key=lambda index: probabilities[index].item(), reverse=True)[:required]
    return tuple(sorted(selected))


def predict_stress_count(count_logits: torch.Tensor, text: str, long_threshold: float = 0.5) -> int:
    """Calibrate rare compound forms without forcing all long words to two stresses."""
    probability_two = count_logits.softmax(dim=-1)[1].item()
    if len(text) >= 15 and not text.endswith(DOUBLE_STRESS_SUFFIXES):
        return 2 if probability_two >= long_threshold else 1
    return int(count_logits.argmax().item()) + 1


@torch.inference_mode()
def evaluate(
    model: AccentTransformer,
    loader: DataLoader,
    examples: list[AccentExample],
    device: torch.device,
    long_threshold: float = 0.5,
) -> dict:
    model.eval()
    exact = 0
    count_exact = 0
    total = 0
    example_offset = 0
    errors: list[dict[str, str]] = []
    for input_ids, attention_mask, _, stress_counts in loader:
        input_ids = input_ids.to(device)
        attention_mask = attention_mask.to(device)
        logits, count_logits = model(input_ids, attention_mask)
        logits = logits.cpu()
        count_logits = count_logits.cpu()
        batch_examples = examples[example_offset : example_offset + len(input_ids)]
        for row_logits, row_count_logits, expected_count, example in zip(logits, count_logits, stress_counts, batch_examples):
            predicted_count_value = predict_stress_count(row_count_logits, example.text, long_threshold)
            predicted = predict_positions(row_logits, example.text, predicted_count_value)
            total += 1
            if predicted_count_value == int(expected_count.item()) + 1:
                count_exact += 1
            if predicted == example.stress_positions:
                exact += 1
            elif len(errors) < 30:
                errors.append({
                    "input": example.text,
                    "expected": render_stress(example.text, example.stress_positions),
                    "predicted": render_stress(example.text, predicted),
                })
        example_offset += len(input_ids)
    return {
        "total": total,
        "exact": exact,
        "exact_accuracy": exact / total if total else 0.0,
        "count_accuracy": count_exact / total if total else 0.0,
        "sample_errors": errors,
    }


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Train an isolated multilingual Kazakhstan FIO accent model.")
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--profile", choices=sorted(PROFILES), default="smoke")
    parser.add_argument("--max-train", type=int, default=20_000)
    parser.add_argument("--max-validation", type=int, default=5_000)
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--max-length", type=int, default=32)
    parser.add_argument("--learning-rate", type=float)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=Path, default=Path("artifacts/best.pt"))
    parser.add_argument("--resume", type=Path, help="Continue from an existing checkpoint without overwriting it.")
    parser.add_argument("--focus-rare", action="store_true", help="Oversample rare two-stress non-suffix forms plus long one-stress controls.")
    parser.add_argument("--save-every-epoch", action="store_true")
    parser.add_argument(
        "--split-strategy",
        choices=("original", "grouped"),
        default="original",
        help="Use source splits or a leakage-resistant split by related-name root.",
    )
    parser.add_argument("--group-seed", type=int, default=42)
    args = parser.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(max(1, min(8, torch.get_num_threads())))
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    focus_stats: dict[str, int] = {}
    if args.focus_rare:
        if args.split_strategy != "original":
            raise ValueError("--focus-rare is not yet supported with --split-strategy grouped.")
        train_examples, focus_stats = build_focused_training_set(
            args.csv, args.max_train, args.max_length, args.seed
        )
    elif args.split_strategy == "original":
        train_examples, validation_examples = reservoir_original_splits_once(
            args.csv, args.max_train, args.max_validation, args.max_length, args.seed
        )
    else:
        train_examples = reservoir_sample(
            args.csv, "train", args.max_train, args.max_length, args.seed,
            args.split_strategy, args.group_seed,
        )
    if args.focus_rare or args.split_strategy != "original":
        validation_examples = reservoir_sample(
            args.csv, "validation", args.max_validation, args.max_length, args.seed + 1,
            args.split_strategy, args.group_seed,
        )
    if not train_examples or not validation_examples:
        raise RuntimeError("Training and validation splits must both contain valid stress-only rows.")

    profile = PROFILES[args.profile]
    resumed_from: str | None = None
    if args.resume:
        model, char_to_id, _ = load_checkpoint(args.resume, device)
        config = model.config
        resumed_from = str(args.resume)
        if config.max_length != args.max_length:
            raise ValueError(f"Resume checkpoint max_length is {config.max_length}, requested {args.max_length}.")
    else:
        characters = collect_characters(train_examples)
        char_to_id = {PAD_TOKEN: 0, UNK_TOKEN: 1, **{char: index + 2 for index, char in enumerate(characters)}}
        config = ModelConfig(
            vocab_size=len(char_to_id),
            max_length=args.max_length,
            d_model=profile["d_model"],
            nhead=profile["nhead"],
            num_layers=profile["num_layers"],
            dim_feedforward=profile["dim_feedforward"],
        )
        model = AccentTransformer(config).to(device)
    train_loader = DataLoader(AccentDataset(train_examples, char_to_id, args.max_length), batch_size=profile["batch_size"], shuffle=True)
    validation_loader = DataLoader(AccentDataset(validation_examples, char_to_id, args.max_length), batch_size=profile["batch_size"], shuffle=False)
    learning_rate = args.learning_rate if args.learning_rate is not None else (1e-4 if args.resume else 3e-4)
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=0.01)
    criterion = nn.CrossEntropyLoss(ignore_index=-100, weight=torch.tensor([1.0, 2.5], device=device))
    count_criterion = nn.CrossEntropyLoss()

    print(
        json.dumps(
            {
                "device": str(device),
                "profile": args.profile,
                "config": asdict(config),
                "train": len(train_examples),
                "validation": len(validation_examples),
                "learning_rate": learning_rate,
                "resumed_from": resumed_from,
                "focus_stats": focus_stats,
                "split_strategy": args.split_strategy,
                "group_seed": args.group_seed,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    best_accuracy = -1.0
    started = time.perf_counter()
    for epoch in range(1, args.epochs + 1):
        model.train()
        running_loss = 0.0
        for input_ids, attention_mask, labels, stress_counts in train_loader:
            input_ids = input_ids.to(device)
            attention_mask = attention_mask.to(device)
            labels = labels.to(device)
            stress_counts = stress_counts.to(device)
            optimizer.zero_grad(set_to_none=True)
            logits, count_logits = model(input_ids, attention_mask)
            token_loss = criterion(logits.reshape(-1, 2), labels.reshape(-1))
            count_loss = count_criterion(count_logits, stress_counts)
            loss = token_loss + 0.5 * count_loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            running_loss += loss.item()

        metrics = evaluate(model, validation_loader, validation_examples, device)
        metrics.update({"epoch": epoch, "train_loss": running_loss / max(1, len(train_loader)), "elapsed_seconds": round(time.perf_counter() - started, 1)})
        print(json.dumps(metrics, ensure_ascii=False), flush=True)
        if metrics["exact_accuracy"] > best_accuracy:
            best_accuracy = metrics["exact_accuracy"]
            save_checkpoint(args.output, model, char_to_id, {**metrics, "profile": args.profile, "config": asdict(config), "resumed_from": resumed_from, "focus_stats": focus_stats, "split_strategy": args.split_strategy, "group_seed": args.group_seed})
        if args.save_every_epoch:
            epoch_path = args.output.with_name(f"{args.output.stem}-epoch{epoch}{args.output.suffix}")
            save_checkpoint(epoch_path, model, char_to_id, {**metrics, "profile": args.profile, "config": asdict(config), "resumed_from": resumed_from, "focus_stats": focus_stats, "split_strategy": args.split_strategy, "group_seed": args.group_seed})


if __name__ == "__main__":
    main()
