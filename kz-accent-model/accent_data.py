from __future__ import annotations

import csv
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator


# Cyrillic vowels seen in Kazakhstan FIO plus common neighbouring-language
# transliterations. The actual character vocabulary is learned from the CSV.
VOWELS = frozenset("аеёиоуыэюяәіүұөєї")
VALID_SPLITS = frozenset({"train", "validation", "test"})
# Patronymic endings used by different communities and spelling conventions in
# Kazakhstan. They are a positive hint for two stresses, never a negative rule
# for words without these endings.
DOUBLE_STRESS_SUFFIXES = (
    "ұлы",
    "улы",
    "қызы",
    "кызы",
    "кизи",
    "қизи",
    "угли",
    "уғли",
    "оглы",
    "оғлы",
    "гызы",
    "ғызы",
)


@dataclass(frozen=True)
class AccentExample:
    text: str
    stress_positions: tuple[int, ...]
    split: str


@dataclass
class DataStats:
    total: int = 0
    accepted: int = 0
    spelling_changes: int = 0
    missing_stress: int = 0
    invalid_stress: int = 0
    too_long: int = 0


def normalize_text(value: str) -> str:
    return unicodedata.normalize("NFC", value.strip().lower())


def parse_accent_pair(input_text: str, output_text: str) -> tuple[str, tuple[int, ...]] | None:
    """Return the unchanged base word and indexes of vowels preceded by '+'."""
    source = normalize_text(input_text)
    target = normalize_text(output_text)
    if not source or target.replace("+", "") != source:
        return None

    positions: list[int] = []
    source_index = 0
    mark_pending = False
    for char in target:
        if char == "+":
            if mark_pending:
                return None
            mark_pending = True
            continue
        if source_index >= len(source) or source[source_index] != char:
            return None
        if mark_pending:
            if char not in VOWELS:
                return None
            positions.append(source_index)
            mark_pending = False
        source_index += 1

    if mark_pending or source_index != len(source) or not positions:
        return None
    return source, tuple(positions)


def iter_examples(
    csv_path: Path,
    split: str | None = None,
    max_length: int = 60,
    limit: int | None = None,
    stats: DataStats | None = None,
) -> Iterator[AccentExample]:
    if split is not None and split not in VALID_SPLITS:
        raise ValueError(f"Unknown split: {split}")

    accepted_for_split = 0
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        required = {"input", "output", "split"}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            raise ValueError(f"CSV must contain columns: {sorted(required)}")

        for row in reader:
            if stats is not None:
                stats.total += 1
            row_split = normalize_text(row.get("split", ""))
            if row_split not in VALID_SPLITS or (split is not None and row_split != split):
                continue

            source = normalize_text(row.get("input", ""))
            target = normalize_text(row.get("output", ""))
            if target.replace("+", "") != source:
                if stats is not None:
                    stats.spelling_changes += 1
                continue
            if len(source) > max_length:
                if stats is not None:
                    stats.too_long += 1
                continue

            parsed = parse_accent_pair(source, target)
            if parsed is None:
                if stats is not None:
                    if "+" not in target:
                        stats.missing_stress += 1
                    else:
                        stats.invalid_stress += 1
                continue

            text, positions = parsed
            if stats is not None:
                stats.accepted += 1
            yield AccentExample(text=text, stress_positions=positions, split=row_split)
            accepted_for_split += 1
            if limit is not None and accepted_for_split >= limit:
                return


def collect_characters(examples: Iterable[AccentExample]) -> list[str]:
    return sorted({char for example in examples for char in example.text})


def render_stress(text: str, positions: Iterable[int]) -> str:
    stress = set(positions)
    return "".join(("+" if index in stress else "") + char for index, char in enumerate(text))
