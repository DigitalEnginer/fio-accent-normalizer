import json
from collections import defaultdict
from pathlib import Path


report = json.loads(
    Path("reports/evaluation-50.json").read_text(encoding="utf-8")
)
rows = report["results"]

successful = [row for row in rows if not row["error"]]
exact = [row for row in successful if row["exact_match"]]
same_text = [row for row in successful if row["text_match"]]
accent_only_mismatch = [
    row for row in successful if row["text_match"] and not row["exact_match"]
]
text_mismatch = [row for row in successful if not row["text_match"]]

print(f"total={len(rows)}")
print(f"successful={len(successful)}")
print(f"transport_errors={len(rows) - len(successful)}")
print(f"exact_successful={len(exact)}/{len(successful)} ({len(exact) / len(successful):.1%})")
print(
    f"same_text_successful={len(same_text)}/{len(successful)} "
    f"({len(same_text) / len(successful):.1%})"
)
print(f"accent_only_mismatch={len(accent_only_mismatch)}")
print(f"text_mismatch={len(text_mismatch)}")

by_category = defaultdict(list)
for row in rows:
    by_category[row["category"]].append(row)

print("\nBY CATEGORY")
for category, category_rows in by_category.items():
    ok = [row for row in category_rows if not row["error"]]
    exact_count = sum(row["exact_match"] for row in ok)
    text_count = sum(row["text_match"] for row in ok)
    errors = len(category_rows) - len(ok)
    print(
        f"{category}: exact={exact_count}/{len(ok)}, "
        f"same_text={text_count}/{len(ok)}, errors={errors}"
    )

print("\nNON-EXACT RESULTS")
for category, category_rows in by_category.items():
    mismatches = [row for row in category_rows if not row["exact_match"]]
    if not mismatches:
        continue
    print(f"\n[{category}] ({len(mismatches)})")
    for row in mismatches:
        actual = row["actual"] or f"ERROR: {row['error']}"
        kind = "accent" if row["text_match"] else "text"
        print(f"{row['input']} | {row['expected']} | {actual} | {kind}")
