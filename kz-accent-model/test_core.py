from accent_data import parse_accent_pair, render_stress
from pathlib import Path
from tempfile import TemporaryDirectory

from train import build_focused_training_set, predict_positions, reservoir_sample
from grouped_split import grouped_split_for, root_key


def test_parse_single_stress() -> None:
    assert parse_accent_pair("аблай", "абл+ай") == ("аблай", (3,))


def test_parse_two_stresses() -> None:
    assert parse_accent_pair("мадетханкызы", "мадетх+анкыз+ы") == ("мадетханкызы", (6, 11))


def test_reject_spelling_change() -> None:
    assert parse_accent_pair("аблае", "абл+ай") is None


def test_reject_mark_before_consonant() -> None:
    assert parse_accent_pair("аблай", "а+блай") is None


def test_render() -> None:
    assert render_stress("аблай", (3,)) == "абл+ай"


def test_reservoir_sample_is_not_prefix_only() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "data.csv"
        rows = ["input;output;category;split"]
        rows.extend(f"имя{index};им+я{index};accent_only;train" for index in range(100))
        path.write_text("\n".join(rows), encoding="utf-8")
        sample = reservoir_sample(path, "train", 10, 32, 42)
        assert len(sample) == 10
        assert any(int(example.text.removeprefix("имя")) >= 10 for example in sample)


def test_related_forms_always_share_grouped_split() -> None:
    assert root_key("абдикеримова")[0] == root_key("абдикеримович")[0]
    assert grouped_split_for("абдикеримова", 42) == grouped_split_for("абдикеримович", 42)


def test_prediction_respects_learned_count() -> None:
    import torch

    logits = torch.zeros((6, 2))
    logits[0, 1] = 3.0
    logits[2, 1] = 2.0
    assert predict_positions(logits, "абидар", 1) == (0,)
    assert predict_positions(logits, "абидар", 2) == (0, 2)


def test_known_patronymic_suffix_is_positive_two_stress_hint() -> None:
    import torch

    text = "махамадсолиугли"
    logits = torch.zeros((len(text), 2))
    logits[10, 1] = 4.0
    logits[11, 1] = 9.0  # Wrong internal suffix vowel must not win.
    assert predict_positions(logits, text, 1) == (10, len(text) - 1)


def test_focused_set_balances_rare_and_long_controls() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "data.csv"
        path.write_text(
            "input;output;category;split\n"
            "александропетров;алекс+андропетр+ов;accent_only;train\n"
            "константиновичев;констант+иновичев;accent_only;train\n"
            "мухамедулы;мухам+едул+ы;accent_only;train\n",
            encoding="utf-8",
        )
        examples, stats = build_focused_training_set(path, 3, 32, 42)
        assert stats["long_double_non_suffix_unique"] == 1
        assert stats["long_single_unique"] == 1
        assert len(examples) == 17
