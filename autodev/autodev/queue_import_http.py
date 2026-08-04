"""Authenticated, restricted HTTP boundary for atomic Issue Plan imports."""
from __future__ import annotations

import argparse
import hmac
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import sys
from typing import Any

from autodev.config import load_autodev_config
from autodev.queue_adapter import QueuePort, create_queue_port


TOKEN_ENV = "AUTODEV_QUEUE_IMPORT_TOKEN"
IMPORT_PATH = "/api/v1/queue/import"
MAX_BODY_BYTES = 1_048_576


class QueueImportHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], queue_port: QueuePort, token: str):
        self.queue_port = queue_port
        self.import_token = token
        super().__init__(address, QueueImportRequestHandler)


class QueueImportRequestHandler(BaseHTTPRequestHandler):
    server: QueueImportHTTPServer

    def log_message(self, _format: str, *_args: Any) -> None:
        """Disable request logging so credentials and request context stay private."""

    def _json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        expected = f"Bearer {self.server.import_token}"
        supplied = self.headers.get("Authorization", "")
        return hmac.compare_digest(supplied.encode(), expected.encode())

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/healthz":
            self._json(HTTPStatus.OK, {"ok": True})
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path != IMPORT_PATH:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not self._authorized():
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        if self.headers.get_content_type() != "application/json":
            self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "json_required"})
            return
        idempotency_key = self.headers.get("Idempotency-Key", "").strip()
        request_id = self.headers.get("X-Request-Id", "").strip()
        if (
            not idempotency_key
            or len(idempotency_key) > 255
            or not request_id
            or len(request_id) > 255
        ):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "required_headers_invalid"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            content_length = -1
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "body_size_invalid"})
            return
        try:
            payload = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid_json"})
            return

        result = self.server.queue_port.import_plan(
            payload,
            idempotency_key=idempotency_key,
        )
        if result.ok and result.receipt is not None:
            self._json(HTTPStatus.OK, result.receipt)
            return
        if result.status == "idempotency_conflict":
            self._json(HTTPStatus.CONFLICT, {"error": result.status})
            return
        if result.status == "invalid_import":
            self._json(HTTPStatus.BAD_REQUEST, {"error": result.status})
            return
        self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "import_failed"})


def create_import_server(
    host: str,
    port: int,
    *,
    queue_port: QueuePort,
    token: str,
) -> QueueImportHTTPServer:
    secret = token.strip()
    if not secret:
        raise ValueError("queue import token must be non-blank")
    if not host:
        raise ValueError("queue import host must be non-blank")
    if isinstance(port, bool) or port < 0 or port > 65535:
        raise ValueError("queue import port is invalid")
    return QueueImportHTTPServer((host, port), queue_port, secret)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Serve the atomic AutoDev Queue Import API"
    )
    parser.add_argument("--project", default="", help="AutoDev project config path")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        token = os.environ.get(TOKEN_ENV, "").strip()
        if not token:
            raise ValueError(f"{TOKEN_ENV} is required")
        config = load_autodev_config(args.project or None)
        server = create_import_server(
            args.host,
            args.port,
            queue_port=create_queue_port(config),
            token=token,
        )
        print(
            f"AutoDev Queue Import listening on http://{args.host}:{server.server_port}",
            flush=True,
        )
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
