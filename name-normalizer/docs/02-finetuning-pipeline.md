# Fine-tuning pipeline

## Current decision

- Teacher/baseline: `gpt-5.6-sol`.
- Fine-tuning candidate: `gpt-4.1-mini-2025-04-14`.
- Production model is not switched until the candidate wins on the untouched test set.
- Fine-tuning is supervised and versioned. It is not triggered after every new name.

## Dataset safety policy

The source `names.csv` is never modified. A generated clean dataset accepts only:

1. Cyrillic inputs whose output differs only by valid stress markers.
2. Single-word Latin inputs mapped to a valid single-word Cyrillic output.

The first pilot excludes all spelling corrections because the historical file does not prove that those changes are correct. It also excludes garbage, multiword values, invalid markers, and conflicting labels.

The deterministic split is based on a hash of normalized input, so the same input cannot appear in train, validation, and test. The pilot is stratified to include 20% Latin examples.

## Commands

Prepare or rebuild derived data:

```powershell
python scripts/prepare_finetuning_data.py
```

Preview the fine-tuning job without external changes:

```powershell
python scripts/start_finetuning.py
```

Create the paid external job only after explicit approval:

```powershell
python scripts/start_finetuning.py --confirm-create-job
```

## Continuous improvement after the pilot

New unique names enter an append-only candidate table. A result becomes eligible for the next training version only after validation. Training runs are periodic batches with a frozen dataset version and an untouched regression test. A newly fine-tuned model is promoted only if it improves stress accuracy without increasing unjustified spelling changes or false `UNKNOWN` results.
