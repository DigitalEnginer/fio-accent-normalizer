# Experiment results

Date: 2026-08-07

## Isolation

The experiment lives entirely in `kz-accent-model/`. It reads the existing
clean CSV but does not write to it and is not connected to the web application.
Removing or ignoring this directory returns the system to its previous state.

`KZ` in the directory name means the Kazakhstan operating context, not ethnic
Kazakh names. The model accepts FIO parts of all origins represented in the
corpus and does not classify nationality.

## Validated data

- Total cleaned CSV rows: 959,379
- Accepted stress-only rows: 946,338
- Excluded spelling/transliteration rows: 13,041
- Train: 757,206
- Validation: 94,793
- Test: 94,339
- One stress mark: 827,519
- Two stress marks: 118,819
- Longest accepted FIO part: 26 characters

## CPU experiments

Hardware visibility: 8 logical CPU threads; CUDA was not available.

### Smoke model

- Training examples: 20,000
- Validation examples: 5,000
- Architecture: 1 layer, 64 hidden units
- Training time: 36.7 seconds for 3 epochs
- Validation exact accuracy: 63.38%
- Test exact accuracy on 10,000 examples: 63.88%
- Test stress-count accuracy: 97.08%

### Laptop model

- Training examples: 100,000
- Validation examples: 10,000
- Architecture: 2 layers, 96 hidden units
- Training time: 830.4 seconds (13m 50s) for 4 epochs
- Validation exact accuracy: 83.40%
- Test exact accuracy on 10,000 untouched examples: 82.84%
- Test stress-count accuracy: 98.37%
- Checkpoint size: 0.615 MB

### Laptop model, 300k

- Training examples: 300,000
- Validation examples: 20,000
- Architecture: 2 layers, 96 hidden units
- Training time: 2,527.4 seconds (42m 7s) for 4 epochs
- Validation exact accuracy: 88.56%
- Full untouched test split: 83,745 / 94,339 exact (88.77%)
- Full-test stress-count accuracy: 99.04%
- One-stress exact accuracy: 88.36%
- Two-stress exact accuracy: 91.67%
- FIO parts of 15+ characters: 61.32%
- Two-stress forms without `ұлы/қызы`-type suffixes: 47.91%
- Long (15+) two-stress forms without those suffixes: 3 / 23 (13.04%)

The last subgroup is very small but important. The training split contains only
229 long two-stress non-suffix examples, and a random 300k sample sees only a
fraction of them. The 300k checkpoint must not be promoted until rare compound
forms are deliberately represented and evaluated on a manually verified set.

### Focused continuation and routed result

The 300k checkpoint was continued for two epochs on a 127,538-row mixture:

- 100,000 broad examples
- all 5,502 two-stress forms without the original suffix list, repeated twice
- all 229 long rare positives, repeated ten additional times
- all 7,122 long one-stress controls, repeated twice

Focused training took 515.2 seconds (8m 35s). It improved long-form accuracy but
slightly reduced general accuracy, so it does not replace the base checkpoint.

Corpus-confirmed patronymic variants were added as positive two-stress hints:
`угли`, `уғли`, `оглы`, `оғлы`, `кизи`, `қизи`, `гызы`, `ғызы`. Absence of one
of these endings never prevents the neural model from predicting two stresses.

The validated router uses:

```text
length < 15  -> base 300k checkpoint
length >= 15 -> focused checkpoint, epoch 2
```

Validation selected this route without using test labels:

- Routed validation exact accuracy: 89.17%
- Routed full-test exact accuracy: 84,293 / 94,339 (89.35%)
- Routed short-form test accuracy: 89.41%
- Routed long-form test accuracy: 84.58%

Eleven remaining long double-stress non-suffix test forms are still unresolved.
They contain highly unique compound patronymics and one contaminated row with
the service word `родственник`. This small subgroup must be manually audited;
its zero exact score must not be hidden by the overall metric.

Manual control predictions:

```text
аблай        -> абл+ай
абдикеримова -> абдикер+имова
иванов       -> ив+анов
```

## Two-stress handling

The final architecture does not force two stresses only for `ұлы`, `улы`,
`қызы`, or `кызы`. It has a separate learned output for whether an FIO part
requires one or two stress marks. This preserves long and compound surnames
that require two stresses.

## External data review

- [KazNERD](https://github.com/IS2AI/KazNERD) contains 136,333 manually
  annotated named entities under CC BY 4.0. It is useful for checking spelling
  diversity but has no stress labels, so it must not be added as target answers.
- [ISSAI Kazakh Speech Corpus](https://issai.nu.edu.kz/kz-speech-corpus/) can be
  useful for future acoustic validation, but it does not directly provide the
  required `+` positions for FIO parts.
- [OpenSLR 140](https://www.openslr.org/140/) is another Kazakh speech resource,
  not a ready-made personal-name stress dataset.

No external dataset was mixed into the current checkpoint.

## Decision

The experiment proves that local CPU training is feasible and that scaling from
20k to 100k and then 300k materially improves overall quality. The 300k
router is still not ready for production because rare compound forms remain
weak and the overall error rate is about 10.65%. Before integration, manually
audit the gold set and compare the same cases against current GPT/RUAccent.

## Leakage-resistant grouped control

The earlier random source split was audited before further scaling. A cautious
root heuristic found that 55.87% of source test rows had a related root form in
source train. This is a warning signal rather than proof for every individual
row, but it makes the old 89.35% metric optimistic for genuinely unseen names.

A new deterministic grouped split assigns every related family/patronymic form
to one split only. It preserves an 80/10/10 distribution and was verified on
all 946,338 accepted rows:

- Train: 757,647 (80.06%)
- Validation: 93,817 (9.91%)
- Test: 94,874 (10.03%)
- Heuristic roots present in more than one split: 0

The first control checkpoint used 100,000 grouped-train rows, 20,000 grouped-
validation rows, the laptop architecture, and two CPU epochs:

- Training time: 439.5 seconds (7m 20s)
- Grouped validation exact accuracy: 77.98%
- Grouped test exact accuracy on 20,000 rows: 78.18%
- Grouped test stress-count accuracy: 98.07%
- Checkpoint: `artifacts/grouped-100k.pt`

The 98.07% count score shows that most remaining errors concern which vowel is
stressed, not whether the FIO part needs one or two marks. This checkpoint is a
measurement baseline and is not connected to the web application.

### Grouped 300k result

The same leakage-resistant experiment was scaled to 300,000 grouped-train rows,
20,000 grouped-validation rows, and four CPU epochs. Every epoch was preserved;
the best checkpoint is epoch 4:

- Training time: 2,021.4 seconds (33m 41s)
- Epoch 1 validation exact accuracy: 83.20%
- Epoch 2 validation exact accuracy: 86.76%
- Epoch 3 validation exact accuracy: 88.24%
- Epoch 4 validation exact accuracy: 89.01%
- Full grouped test: 84,332 / 94,874 exact (88.89%)
- Full grouped-test stress-count accuracy: 98.99%
- Checkpoint: `artifacts/grouped-300k.pt`
- Full report: `artifacts/grouped-300k-full-test.json`

This improves the grouped 100k test result by 10.71 percentage points. It is
only 0.46 points below the old routed 89.35% result, despite the stricter split.
Those two headline metrics are not perfectly interchangeable because they use
different splits and the old route combines two checkpoints. The grouped 300k
result is the more credible estimate for previously unseen related-name roots.
It remains isolated from the web application pending human-gold evaluation.
