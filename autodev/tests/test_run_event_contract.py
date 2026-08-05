from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from autodev.run_store import append_event, create_run


class RunEventContractTests(unittest.TestCase):
    def test_file_events_have_stable_schema_identity_and_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = SimpleNamespace(
                project=SimpleNamespace(id="event-test", repo_root=root),
                agent=SimpleNamespace(
                    builder=SimpleNamespace(timeout_minutes=20, max_turns=8)
                ),
                verify=SimpleNamespace(command_timeout_minutes=10),
                policy=SimpleNamespace(
                    max_tasks_per_loop=1,
                    max_tasks_per_loop_after_direction_gate=1,
                    max_minutes_per_loop=30,
                    direction_check=SimpleNamespace(
                        mode="off", every_done_tasks=1
                    ),
                    main_worktree_dirty_policy="fail",
                ),
                branch=SimpleNamespace(base_ref="main"),
            )
            paths = create_run(config, "run-event-test")
            first = append_event(
                root, "run-event-test", level="info", phase="builder",
                task_id="H-001", message="builder started",
            )
            second = append_event(
                root, "run-event-test", level="info", phase="verify",
                task_id="H-001", message="verify started",
            )
            stored = [json.loads(line) for line in paths.events_jsonl.read_text().splitlines()]

        self.assertEqual(first["schema_version"], "autodev.run-event.v1")
        self.assertEqual([first["sequence"], second["sequence"]], [1, 2])
        self.assertNotEqual(first["event_id"], second["event_id"])
        self.assertEqual(stored, [first, second])

    def test_file_events_propagate_valid_observability_context_without_secrets(self) -> None:
        context = {
            "schema_version": "harness.observability.v1",
            "process": "gateway",
            "request_id": "request-autodev-42",
            "goal_id": "00000000-0000-4000-8000-000000000003",
            "issue_id": "00000000-0000-4000-8000-000000000004",
            "run_id": "00000000-0000-4000-8000-000000000005",
            "trace_id": "1" * 32,
            "span_id": "2" * 16,
            "trace_flags": "01",
        }
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {
                "HARNESS_OBSERVABILITY_CONTEXT": json.dumps(context),
                "AUTODEV_API_TOKEN": "must-not-appear",
            },
            clear=False,
        ):
            root = Path(directory)
            config = SimpleNamespace(
                project=SimpleNamespace(id="event-test", repo_root=root),
                agent=SimpleNamespace(
                    builder=SimpleNamespace(timeout_minutes=20, max_turns=8)
                ),
                verify=SimpleNamespace(command_timeout_minutes=10),
                policy=SimpleNamespace(
                    max_tasks_per_loop=1,
                    max_tasks_per_loop_after_direction_gate=1,
                    max_minutes_per_loop=30,
                    direction_check=SimpleNamespace(mode="off", every_done_tasks=1),
                    main_worktree_dirty_policy="fail",
                ),
                branch=SimpleNamespace(base_ref="main"),
            )
            create_run(config, "observability-test")
            event = append_event(
                root,
                "observability-test",
                level="info",
                phase="builder",
                task_id="H-1101",
                message="builder started",
            )

        self.assertEqual(event["observability"]["request_id"], "request-autodev-42")
        self.assertEqual(event["observability"]["trace_id"], "1" * 32)
        self.assertNotIn("must-not-appear", json.dumps(event))


if __name__ == "__main__":
    unittest.main()
