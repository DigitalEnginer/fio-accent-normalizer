from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Iterator

from accent_data import DOUBLE_STRESS_SUFFIXES, VALID_SPLITS, AccentExample, iter_examples


# Only productive family/patronymic endings are removed. This is deliberately
# conservative: the key is a leakage barrier, not a nationality classifier.
RUSSIAN_FORM_SUFFIXES = (
    "ович", "евич", "овна", "евна", "ична",
    "овская", "евская", "инская", "ский", "цкий",
    "ова", "ева", "ина", "ына", "ов", "ев", "ин", "ын", "ич",
)
ROOT_SUFFIXES = tuple(
    sorted(set(DOUBLE_STRESS_SUFFIXES + RUSSIAN_FORM_SUFFIXES), key=len, reverse=True)
)


def root_key(text: str) -> tuple[str, str]:
    """Return a cautious family root and the suffix removed from it."""
    for suffix in ROOT_SUFFIXES:
        if text.endswith(suffix) and len(text) - len(suffix) >= 4:
            return text[: -len(suffix)], suffix
    return text, ""


def grouped_split_for(text: str, seed: int = 42) -> str:
    """Assign all forms of one heuristic root to one stable 80/10/10 split."""
    key, _ = root_key(text)
    digest = hashlib.sha256(f"{seed}:{key}".encode("utf-8")).digest()
    bucket = int.from_bytes(digest[:8], "big") % 10_000
    if bucket < 8_000:
        return "train"
    if bucket < 9_000:
        return "validation"
    return "test"


def iter_grouped_examples(
    csv_path: Path,
    split: str,
    max_length: int = 60,
    seed: int = 42,
) -> Iterator[AccentExample]:
    """Read every accepted row and replace its old split with a grouped split."""
    if split not in VALID_SPLITS:
        raise ValueError(f"Unknown split: {split}")
    seen: set[tuple[str, tuple[int, ...]]] = set()
    for example in iter_examples(csv_path, max_length=max_length):
        if grouped_split_for(example.text, seed) != split:
            continue
        identity = (example.text, example.stress_positions)
        if identity in seen:
            continue
        seen.add(identity)
        yield AccentExample(
            text=example.text,
            stress_positions=example.stress_positions,
            split=split,
        )
