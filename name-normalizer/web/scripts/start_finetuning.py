from __future__ import annotations

import argparse
import json
import mimetypes
import os
import secrets
import urllib.error
import urllib.request
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TRAIN_PATH = PROJECT_ROOT / "data" / "finetuning" / "train.jsonl"
VALIDATION_PATH = PROJECT_ROOT / "data" / "finetuning" / "validation.jsonl"
REPORT_PATH = PROJECT_ROOT / "reports" / "finetuning-job.json"
DEFAULT_MODEL = "gpt-4.1-mini-2025-04-14"
API_ROOT = "https://api.openai.com/v1"


def load_local_env() -> None:
    env_path = PROJECT_ROOT / ".env.local"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8-sig").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def request_json(
    path: str,
    api_key: str,
    *,
    body: bytes,
    content_type: str,
) -> dict[str, object]:
    request = urllib.request.Request(
        f"{API_ROOT}{path}",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": content_type,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI API error {error.code}: {details}") from error


def upload_file(path: Path, api_key: str) -> str:
    boundary = f"----name-normalizer-{secrets.token_hex(16)}"
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    body = bytearray()

    def add(value: bytes) -> None:
        body.extend(value)
        body.extend(b"\r\n")

    add(f"--{boundary}".encode())
    add(b'Content-Disposition: form-data; name="purpose"')
    add(b"")
    add(b"fine-tune")
    add(f"--{boundary}".encode())
    add(
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"'.encode()
    )
    add(f"Content-Type: {mime_type}".encode())
    add(b"")
    body.extend(path.read_bytes())
    body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode())

    result = request_json(
        "/files",
        api_key,
        body=bytes(body),
        content_type=f"multipart/form-data; boundary={boundary}",
    )
    file_id = result.get("id")
    if not isinstance(file_id, str):
        raise RuntimeError(f"Upload returned no file id: {result}")
    return file_id


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Upload the pilot dataset and create an OpenAI fine-tuning job."
    )
    parser.add_argument(
        "--confirm-create-job",
        action="store_true",
        help="Required because file uploads and training create external billable state.",
    )
    args = parser.parse_args()

    for path in (TRAIN_PATH, VALIDATION_PATH):
        if not path.exists():
            raise FileNotFoundError(f"Missing dataset: {path}")

    model = os.environ.get("OPENAI_FINE_TUNING_MODEL", DEFAULT_MODEL)
    preview = {
        "model": model,
        "training_file": {"path": str(TRAIN_PATH), "bytes": TRAIN_PATH.stat().st_size},
        "validation_file": {
            "path": str(VALIDATION_PATH),
            "bytes": VALIDATION_PATH.stat().st_size,
        },
    }
    if not args.confirm_create_job:
        print(json.dumps({"dry_run": True, **preview}, ensure_ascii=False, indent=2))
        print("Job not created. Re-run with --confirm-create-job after approval.")
        return

    load_local_env()
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")

    training_file_id = upload_file(TRAIN_PATH, api_key)
    validation_file_id = upload_file(VALIDATION_PATH, api_key)
    upload_report = {
        **preview,
        "training_file_id": training_file_id,
        "validation_file_id": validation_file_id,
        "job": None,
    }
    REPORT_PATH.write_text(
        json.dumps(upload_report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    request_body = json.dumps(
        {
            "model": model,
            "training_file": training_file_id,
            "validation_file": validation_file_id,
            "suffix": "kz-name-normalizer-v1",
        }
    ).encode("utf-8")
    job = request_json(
        "/fine_tuning/jobs",
        api_key,
        body=request_body,
        content_type="application/json",
    )
    report = {**upload_report, "job": job}
    REPORT_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(job, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
