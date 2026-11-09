from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
REPORT_PATH = PROJECT_ROOT / "reports" / "uploaded-finetuning-files.json"


def load_local_env() -> None:
    path = PROJECT_ROOT / ".env.local"
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key, value = stripped.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def main() -> None:
    load_local_env()
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")
    request = urllib.request.Request(
        "https://api.openai.com/v1/files?purpose=fine-tune&limit=100",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI API error {error.code}: {details}") from error

    matching = [
        item
        for item in payload.get("data", [])
        if item.get("filename") in {"train.jsonl", "validation.jsonl"}
    ]
    matching.sort(key=lambda item: item.get("created_at", 0), reverse=True)
    REPORT_PATH.write_text(
        json.dumps({"files": matching}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        json.dumps(
            [
                {
                    "id": item.get("id"),
                    "filename": item.get("filename"),
                    "bytes": item.get("bytes"),
                    "status": item.get("status"),
                    "created_at": item.get("created_at"),
                }
                for item in matching[:10]
            ],
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
