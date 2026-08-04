from __future__ import annotations

import json
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import yaml

from autodev.queue_adapter import TaskHarnessQueueAdapter
from autodev.queue_import_http import create_import_server
from tests.test_queue_import import import_payload


class QueueImportHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.queue_path = Path(self.temporary.name) / "queue.yaml"
        self.queue_path.write_text(
            yaml.safe_dump({"schema_version": 1, "policy": {}, "tasks": []}, sort_keys=False),
            encoding="utf-8",
        )
        self.server = create_import_server(
            "127.0.0.1",
            0,
            queue_port=TaskHarnessQueueAdapter(self.queue_path),
            token="server-secret",
        )
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_port}/api/v1/queue/import"

    def post(self, *, token: str = "server-secret", key: str = "projection-1"):
        request = Request(
            self.url,
            method="POST",
            data=json.dumps(import_payload()).encode(),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Idempotency-Key": key,
                "X-Request-Id": "request-1",
            },
        )
        return urlopen(request, timeout=2)

    def test_authenticated_import_returns_the_atomic_receipt(self) -> None:
        with self.post() as response:
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
        self.assertTrue(payload["atomic"])
        self.assertEqual(payload["tasks"][1]["externalTaskId"], "H-002")

        with self.post(key="projection-2") as replay:
            self.assertEqual(json.loads(replay.read()), payload)
        queue = yaml.safe_load(self.queue_path.read_text(encoding="utf-8"))
        self.assertEqual(len(queue["tasks"]), 2)

    def test_bad_token_and_bad_contract_never_mutate_the_queue(self) -> None:
        before = self.queue_path.read_bytes()
        with self.assertRaises(HTTPError) as unauthorized:
            self.post(token="wrong-secret")
        self.assertEqual(unauthorized.exception.code, 401)
        unauthorized.exception.close()
        self.assertEqual(self.queue_path.read_bytes(), before)

        request = Request(
            self.url,
            method="POST",
            data=b"{}",
            headers={
                "Authorization": "Bearer server-secret",
                "Content-Type": "application/json",
                "Idempotency-Key": "invalid",
                "X-Request-Id": "request-2",
            },
        )
        with self.assertRaises(HTTPError) as invalid:
            urlopen(request, timeout=2)
        self.assertEqual(invalid.exception.code, 400)
        invalid.exception.close()
        self.assertEqual(self.queue_path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
