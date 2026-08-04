from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import json
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
