from __future__ import annotations

import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch


WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
MODEL_ROOT = WORKSPACE_ROOT / "kz-accent-model"
CHECKPOINT = Path(
    os.environ.get(
        "KZ_ACCENT_CHECKPOINT",
        str(MODEL_ROOT / "artifacts" / "grouped-gold-v1-full.pt"),
    )
)
HOST = "127.0.0.1"
PORT = int(os.environ.get("KZ_ACCENT_PORT", "8766"))
NAME_PART = re.compile(r"^[\u0400-\u04ff\-'’]+$", re.IGNORECASE)

sys.path.insert(0, str(MODEL_ROOT))

from accent_data import normalize_text, render_stress  # noqa: E402
from model import load_checkpoint  # noqa: E402
from train import predict_positions, predict_stress_count  # noqa: E402


DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
MODEL, CHAR_TO_ID, METADATA = load_checkpoint(CHECKPOINT, DEVICE)
MODEL_NAME = "kz-accent-gold-v1-full"


def accent(value: str) -> str | None:
    text = normalize_text(value).replace("+", "")
    if (
        not text
        or len(text) > MODEL.config.max_length
        or not NAME_PART.fullmatch(text)
        or not any(char in "аеёиоуыэюяәіүұөєї" for char in text)
    ):
        return None

    ids = torch.tensor(
        [[CHAR_TO_ID.get(char, 1) for char in text]],
        dtype=torch.long,
        device=DEVICE,
    )
    mask = torch.ones_like(ids, dtype=torch.bool)
    with torch.inference_mode():
        token_logits, count_logits = MODEL(ids, mask)
        stress_count = predict_stress_count(count_logits[0].cpu(), text)
        positions = predict_positions(token_logits[0].cpu(), text, stress_count)
    if not positions:
        return None
    return render_stress(text, positions)


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self.send_json(
                200,
                {
                    "status": "ok",
                    "model": MODEL_NAME,
                    "checkpoint": CHECKPOINT.name,
                    "device": str(DEVICE),
                    "validation_accuracy": METADATA.get("exact_accuracy"),
                },
            )
            return
        self.send_json(404, {"error": "NOT_FOUND"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/accent":
            self.send_json(404, {"error": "NOT_FOUND"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            value = payload.get("value", "")
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "INVALID_JSON"})
            return

        if not isinstance(value, str):
            self.send_json(400, {"error": "STRING_REQUIRED"})
            return

        result = accent(value)
        if result is None:
            self.send_json(422, {"error": "UNSUPPORTED_NAME_PART"})
            return
        self.send_json(200, {"result": result, "model": MODEL_NAME})

    def log_message(self, format: str, *args: object) -> None:
        return


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"{MODEL_NAME} ready at http://{HOST}:{PORT} "
        f"({CHECKPOINT.name}, {DEVICE})",
        flush=True,
    )
    server.serve_forever()
