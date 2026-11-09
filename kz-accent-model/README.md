# Multilingual Kazakhstan FIO Accent Model (isolated experiment)

This directory is an isolated experiment. It does not modify or replace the
current web application or its RUAccent service.

This is not a model for ethnic Kazakh names only. It is intended for names,
surnames, and patronymics of Kazakhstan residents of any origin: Kazakh,
Russian, Uyghur, Tatar, Georgian, Korean, Chinese, and others, in the spelling
used by the source system.

The model has one responsibility: insert `+` before stressed vowels in an
already cleaned Cyrillic FIO part. GPT remains responsible
for deciding whether the input is a plausible FIO part and for correcting only
obvious spelling/layout/transliteration errors.

The character vocabulary is learned from the training corpus. It is not fixed
to either the Russian or Kazakh alphabet. Nationality detection is deliberately
not part of the routing logic.

The network learns two related outputs: stress positions and whether the word
requires one or two stress marks. Two stresses are therefore not restricted to
`ұлы/қызы`; long and compound surnames can receive two when the corpus supports
that pattern.

## Data policy

Only rows where `output.replace("+", "") == input` are accepted. This prevents
the stress model from learning spelling correction or transliteration. Rows may
contain one or two stress marks.

The source CSV is read-only and remains in the existing project:

```text
../name-normalizer/web/data/finetuning/names-clean.csv
```

## Quick start (Windows PowerShell)

Create a virtual environment and install CPU PyTorch:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Inspect and validate the data without training:

```powershell
.\.venv\Scripts\python.exe prepare_dataset.py
```

Run a small CPU smoke experiment:

```powershell
.\.venv\Scripts\python.exe train.py --profile smoke --max-train 20000 --epochs 2
```

Run the leakage-resistant control experiment. Related surname and patronymic
forms are assigned together, so they cannot occur in both training and test:

```powershell
.\.venv\Scripts\python.exe train.py --profile laptop --split-strategy grouped --max-train 100000 --max-validation 20000 --epochs 2 --output artifacts\grouped-100k.pt
.\.venv\Scripts\python.exe evaluate.py --checkpoint artifacts\grouped-100k.pt --split-strategy grouped --split test --limit 20000
```

Scale the same honest experiment to 300k and retain every epoch:

```powershell
.\.venv\Scripts\python.exe train.py --profile laptop --split-strategy grouped --max-train 300000 --max-validation 20000 --epochs 4 --save-every-epoch --output artifacts\grouped-300k.pt
.\.venv\Scripts\python.exe evaluate.py --checkpoint artifacts\grouped-300k.pt --split-strategy grouped --split test --limit 1000000 --output artifacts\grouped-300k-full-test.json
```

Run the office-laptop profile after the smoke run is successful:

```powershell
.\.venv\Scripts\python.exe train.py --profile laptop --max-train 300000 --epochs 5
```

Targeted fine-tuning from an existing checkpoint remains separate from it:

```powershell
.\.venv\Scripts\python.exe train.py --profile laptop --resume artifacts\laptop-300k-count-aware.pt --focus-rare --max-train 100000 --max-validation 20000 --epochs 2 --save-every-epoch --output artifacts\laptop-300k-focused.pt
```

Predict with the trained checkpoint:

```powershell
.\.venv\Scripts\python.exe predict.py "абдикеримова"
```

Use the validated short/long router:

```powershell
.\.venv\Scripts\python.exe predict_routed.py "абдикеримова"
.\.venv\Scripts\python.exe evaluate_routed.py --split test
```

Evaluate on an untouched test sample:

```powershell
.\.venv\Scripts\python.exe evaluate.py --checkpoint artifacts\best.pt --split test --limit 10000
```

All generated checkpoints and reports are written under `artifacts/` inside
this directory. The current production application is not connected to them.

Measured experiment results are recorded in `EXPERIMENT_RESULTS.md`.

## Human gold review

The review workbook is generated at:

```text
outputs/name-accent-audit/gold-review-500.xlsx
```

After an expert fills the status and corrected result columns, validate and
compile confirmed rows with:

```powershell
node compile_gold.mjs outputs\name-accent-audit\gold-review-500.xlsx
```

The compiler writes `gold-validation.json` and, when all approved rows are
valid, `gold-test.csv`. Pending, uncertain, and rejected rows are not added to
the gold set.

## Promotion rule

Do not connect a checkpoint to the web application merely because training
finished. First compare `exact_accuracy` on the untouched test split against
the current GPT and RUAccent routes. Promotion should require a manually
verified gold set as well.
