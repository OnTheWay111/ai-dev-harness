from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

import yaml

from autodev.adapters import queue_yaml
from autodev.queue_import import (
    QueueImportConflictError,
    QueueImportError,
    QueueImportValidationError,
)


def import_payload() -> dict:
    return {
        "schemaVersion": "autodev-queue-import.v1",
        "atomic": True,
        "issuePlanId": "00000000-0000-4000-8000-000000000010",
        "planDigest": "a" * 64,
        "tasks": [
            {
                "issueKey": "DEV-01",
                "title": "Create the import boundary",
                "goal": "Import an approved plan atomically.",
                "developmentPrompt": (
                    "Implement the approved DEV-01 contract, preserve its acceptance "
                    "criteria, modify app/import.py, and run python -m unittest."
                ),
                "acceptance": [
                    {"criterionRef": "AC-01", "statement": "All tasks are written together."}
                ],
                "verify": ["python -m unittest"],
                "completionEvidence": [
                    {"kind": "test", "description": "The import suite passes.", "required": True}
                ],
                "dependencies": [],
                "expectedFiles": ["app/import.py"],
                "wave": 1,
                "capabilityTier": "general_coding",
                "reasoningEffort": "medium",
                "routingPolicyRevision": "model-router.v1",
            },
            {
                "issueKey": "DEV-02",
                "title": "Expose the import endpoint",
                "goal": "Accept authenticated imports over HTTP.",
                "developmentPrompt": (
                    "Implement the approved DEV-02 contract after DEV-01, modify "
                    "app/http.py, and run python -m unittest."
                ),
                "acceptance": [
                    {"criterionRef": "AC-02", "statement": "The endpoint returns a receipt."}
                ],
                "verify": ["python -m unittest"],
                "completionEvidence": [
                    {"kind": "test", "description": "The HTTP suite passes.", "required": True}
                ],
                "dependencies": ["DEV-01"],
                "expectedFiles": ["app/http.py"],
                "wave": 2,
                "capabilityTier": "advanced_coding",
                "reasoningEffort": "high",
                "routingPolicyRevision": "model-router.v1",
            },
        ],
    }


class YamlQueueImportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.queue_path = Path(self.temporary.name) / "queue.yaml"
        self.queue_path.write_text(
            yaml.safe_dump({"schema_version": 1, "policy": {}, "tasks": []}, sort_keys=False),
            encoding="utf-8",
        )

    def test_import_is_atomic_and_preserves_execution_contract(self) -> None:
        receipt = queue_yaml.import_plan(
            self.queue_path,
            import_payload(),
            idempotency_key="projection-1",
        )

        self.assertTrue(receipt["atomic"])
        self.assertEqual(receipt["planDigest"], "a" * 64)
        self.assertEqual(
            receipt["tasks"],
            [
                {"issueKey": "DEV-01", "externalTaskId": "H-001"},
                {"issueKey": "DEV-02", "externalTaskId": "H-002"},
            ],
        )
        queue = queue_yaml.load_queue(self.queue_path)
        self.assertEqual(len(queue["tasks"]), 2)
        first, second = queue["tasks"]
        self.assertEqual(first["status"], "pending")
        self.assertEqual(first["approved_by"], "ai-dev-harness")
        self.assertEqual(second["dependencies"], ["H-001"])
        self.assertEqual(first["development_prompt"], import_payload()["tasks"][0]["developmentPrompt"])
        self.assertEqual(first["exclusive_resources"], ["app/import.py"])
        self.assertEqual(first["model_route"]["capability_tier"], "general_coding")
        self.assertTrue(first["completion_evidence"][0]["required"])

    def test_replay_by_key_or_plan_identity_does_not_duplicate_tasks(self) -> None:
        first = queue_yaml.import_plan(
            self.queue_path, import_payload(), idempotency_key="projection-1"
        )
        by_key = queue_yaml.import_plan(
            self.queue_path, import_payload(), idempotency_key="projection-1"
        )
        by_plan = queue_yaml.import_plan(
            self.queue_path, import_payload(), idempotency_key="projection-2"
        )

        self.assertEqual(by_key, first)
        self.assertEqual(by_plan, first)
        queue = queue_yaml.load_queue(self.queue_path)
        self.assertEqual(len(queue["tasks"]), 2)
        self.assertEqual(
            queue["imports"][0]["idempotency_keys"],
            ["projection-1", "projection-2"],
        )
        conflict = import_payload()
        conflict["issuePlanId"] = "00000000-0000-4000-8000-000000000099"
        conflict["planDigest"] = "9" * 64
        with self.assertRaises(QueueImportConflictError):
            queue_yaml.import_plan(
                self.queue_path, conflict, idempotency_key="projection-2"
            )

    def test_conflict_or_invalid_batch_leaves_queue_unchanged(self) -> None:
        queue_yaml.import_plan(
            self.queue_path, import_payload(), idempotency_key="projection-1"
        )
        before = self.queue_path.read_bytes()

        conflict = import_payload()
        conflict["planDigest"] = "b" * 64
        with self.assertRaises(QueueImportConflictError):
            queue_yaml.import_plan(
                self.queue_path, conflict, idempotency_key="projection-1"
            )
        self.assertEqual(self.queue_path.read_bytes(), before)

        cyclic = deepcopy(import_payload())
        cyclic["tasks"][0]["dependencies"] = ["DEV-02"]
        with self.assertRaises(QueueImportValidationError):
            queue_yaml.import_plan(
                self.queue_path, cyclic, idempotency_key="projection-invalid"
            )
        self.assertEqual(self.queue_path.read_bytes(), before)

        bad_route = deepcopy(import_payload())
        bad_route["tasks"][1]["capabilityTier"] = "cheap_and_wrong"
        with self.assertRaises(QueueImportValidationError):
            queue_yaml.import_plan(
                self.queue_path, bad_route, idempotency_key="projection-invalid"
            )
        self.assertEqual(self.queue_path.read_bytes(), before)

    def test_replay_fails_closed_when_the_durable_receipt_is_corrupted(self) -> None:
        queue_yaml.import_plan(
            self.queue_path, import_payload(), idempotency_key="projection-1"
        )
        queue = yaml.safe_load(self.queue_path.read_text(encoding="utf-8"))
        queue["imports"][0]["receipt"]["tasks"][0]["externalTaskId"] = "H-999"
        self.queue_path.write_text(yaml.safe_dump(queue, sort_keys=False), encoding="utf-8")
        before = self.queue_path.read_bytes()

        with self.assertRaises(QueueImportError):
            queue_yaml.import_plan(
                self.queue_path, import_payload(), idempotency_key="projection-1"
            )
        self.assertEqual(self.queue_path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
