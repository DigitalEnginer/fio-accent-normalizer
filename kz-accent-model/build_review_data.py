from __future__ import annotations

import argparse
import json
import random
from collections import Counter, defaultdict
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from accent_data import DOUBLE_STRESS_SUFFIXES, VOWELS, iter_examples, render_stress
from model import load_checkpoint
from train import DEFAULT_CSV, AccentDataset, predict_positions, predict_stress_count


KAZAKH_CHARS = frozenset("әіғқңүұһәө")
SERVICE_MARKERS = (
    "родственник",
    "контакт",
    "комментар",
    "телефон",
    "номер",
    "сестра",
    "брат",
    "мама",
    "папа",
    "супруг",
    "клиент",
)


def predict_examples(checkpoint: Path, examples: list, device: torch.device) -> list[dict]:
    model, char_to_id, _ = load_checkpoint(checkpoint, device)
    loader = DataLoader(AccentDataset(examples, char_to_id, model.config.max_length), batch_size=256, shuffle=False)
    results: list[dict] = []
    offset = 0
    with torch.inference_mode():
        for input_ids, attention_mask, _, _ in loader:
            token_logits, count_logits = model(input_ids.to(device), attention_mask.to(device))
            token_probabilities = token_logits.softmax(dim=-1).cpu()[:, :, 1]
            count_probabilities = count_logits.softmax(dim=-1).cpu()
            batch_examples = examples[offset : offset + len(input_ids)]
            for token_probs, count_probs, example in zip(token_probabilities, count_probabilities, batch_examples):
                count = predict_stress_count(count_probs.log(), example.text)
                # predict_positions expects two-class logits; log probabilities
                # preserve ordering after its softmax.
                fake_logits = torch.stack(((1.0 - token_probs).clamp_min(1e-8).log(), token_probs.clamp_min(1e-8).log()), dim=-1)
                positions = predict_positions(fake_logits, example.text, count)
                chosen = [float(token_probs[position].item()) for position in positions]
                confidence = (min(chosen) if chosen else 0.0) * float(count_probs[count - 1].item())
                results.append({
                    "example": example,
                    "positions": positions,
                    "output": render_stress(example.text, positions),
                    "predicted_count": count,
                    "confidence": round(confidence, 4),
                })
            offset += len(input_ids)
    return results


def classify(text: str, expected_count: int) -> tuple[str, str, str]:
    service = next((marker for marker in SERVICE_MARKERS if marker in text), None)
    known_suffix = text.endswith(DOUBLE_STRESS_SUFFIXES)
    if service:
        return "service_candidate", "Высокий", f"В строке найден служебный маркер: {service}"
    if len(text) >= 15 and expected_count == 2 and not known_suffix:
        return "long_double_other", "Высокий", "Длинная двухударная форма без известного патронимического суффикса"
    if len(text) >= 15:
        return "long_form", "Высокий", "Длина 15+ символов"
    if expected_count == 2 and not known_suffix:
        return "double_other", "Средний", "Два ударения без известного патронимического суффикса"
    if expected_count == 2 and known_suffix:
        return "double_suffix", "Средний", "Два ударения с патронимическим суффиксом"
    if any(char in KAZAKH_CHARS for char in text):
        return "kazakh_letters", "Средний", "Содержит специфические казахские буквы"
    return "general", "Обычный", "Остальная ошибка модели"


def stratified_sample(rows: list[dict], size: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
    buckets: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        buckets[row["category"]].append(row)
    for values in buckets.values():
        rng.shuffle(values)

    quotas = {
        "service_candidate": 30,
        "long_double_other": 40,
        "long_form": 90,
        "double_other": 90,
        "double_suffix": 90,
        "kazakh_letters": 90,
        "general": 70,
    }
    selected: list[dict] = []
    selected_ids: set[str] = set()
    for category, quota in quotas.items():
        for row in buckets.get(category, [])[:quota]:
            selected.append(row)
            selected_ids.add(row["source_input"])

    remaining = [row for row in rows if row["source_input"] not in selected_ids]
    rng.shuffle(remaining)
    selected.extend(remaining[: max(0, size - len(selected))])
    selected = selected[:size]
    rng.shuffle(selected)
    for index, row in enumerate(selected, start=1):
        row["id"] = f"REV-{index:04d}"
    return selected


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a stratified human-review queue from routed model errors.")
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--base", type=Path, default=Path("artifacts/laptop-300k-count-aware.pt"))
    parser.add_argument("--focused", type=Path, default=Path("artifacts/laptop-300k-focused-epoch2.pt"))
    parser.add_argument("--size", type=int, default=500)
    parser.add_argument("--seed", type=int, default=20260807)
    parser.add_argument("--output", type=Path, default=Path("review/review-data.json"))
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    examples = list(iter_examples(args.csv, split="test", max_length=32))
    short = [example for example in examples if len(example.text) < 15]
    long = [example for example in examples if len(example.text) >= 15]
    predictions = predict_examples(args.base, short, device) + predict_examples(args.focused, long, device)

    errors: list[dict] = []
    for prediction in predictions:
        example = prediction["example"]
        if prediction["positions"] == example.stress_positions:
            continue
        expected_count = len(example.stress_positions)
        category, priority, reason = classify(example.text, expected_count)
        errors.append({
            "id": "",
            "priority": priority,
            "category": category,
            "review_reason": reason,
            "source_input": example.text,
            "clean_input": example.text,
            "dataset_output": render_stress(example.text, example.stress_positions),
            "model_output": prediction["output"],
            "length": len(example.text),
            "dataset_stress_count": expected_count,
            "model_stress_count": prediction["predicted_count"],
            "has_kazakh_letters": any(char in KAZAKH_CHARS for char in example.text),
            "service_candidate": category == "service_candidate",
            "model_confidence_heuristic": prediction["confidence"],
            "human_status": "Не проверено",
            "human_output": "",
            "reviewer_notes": "",
        })

    selected = stratified_sample(errors, args.size, args.seed)
    payload = {
        "source": str(args.csv.resolve()),
        "base_checkpoint": str(args.base),
        "focused_checkpoint": str(args.focused),
        "test_examples": len(examples),
        "total_model_errors": len(errors),
        "selected": len(selected),
        "selected_categories": dict(sorted(Counter(row["category"] for row in selected).items())),
        "rows": selected,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in payload.items() if key != "rows"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

