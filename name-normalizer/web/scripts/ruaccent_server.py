from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from ruaccent import RUAccent


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = PROJECT_ROOT / "data" / "ruaccent"
HOST = "127.0.0.1"
PORT = 8765
RUSSIAN_WORD = re.compile(r"^[а-яё]+$", re.IGNORECASE)


def load_accentizer() -> RUAccent:
    accentizer = RUAccent()
    accentizer.load(
        omograph_model_size="tiny",
        use_dictionary=True,
        tiny_mode=True,
        device="CPU",
        workdir=str(MODEL_DIR),
    )

    # Transformers 5 no longer includes this field for the bundled tokenizer,
    # while the released ONNX graph still requires it.
    accentizer.accent_model.tokenizer.model_input_names = [
        "input_ids",
        "token_type_ids",
        "attention_mask",
    ]
    return accentizer


ACCENTIZER = load_accentizer()


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
            self.send_json(200, {"status": "ok", "model": "ruaccent-tiny"})
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

        if not isinstance(value, str) or not RUSSIAN_WORD.fullmatch(value):
            self.send_json(400, {"error": "RUSSIAN_WORD_REQUIRED"})
            return

        result = ACCENTIZER.process_all(value).lower()
        self.send_json(200, {"result": result, "model": "ruaccent-tiny"})

    def log_message(self, format: str, *args: object) -> None:
        return


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"RUAccent ready at http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
