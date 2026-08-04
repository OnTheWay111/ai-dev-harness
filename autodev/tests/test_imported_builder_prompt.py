from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from autodev.controller import build_builder_prompt


class ImportedBuilderPromptTests(unittest.TestCase):
    def test_imported_execution_contract_is_rendered_verbatim(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            builder = SimpleNamespace(timeout_minutes=20, max_turns=8)
            config = SimpleNamespace(
                project=SimpleNamespace(id="prompt-test", repo_root=root),
                branch=SimpleNamespace(base_ref="main"),
                agent=SimpleNamespace(builder=builder, builder_name="codex"),
                verify=SimpleNamespace(default=["fallback"], command_timeout_minutes=10),
            )
            contract = "Use the exact approved development contract and run python -m unittest."
            task = {
                "id": "H-001",
                "title": "Imported task",
                "priority": "P2",
                "area": "issue-plan",
                "goal": "Preserve the contract",
                "acceptance": ["[AC-01] contract preserved"],
                "verify": ["python -m unittest"],
                "artifacts": [],
                "raw": {
                    "development_prompt": contract,
                    "expected_files": ["autodev/queue_import.py"],
                    "completion_evidence": [
                        {"kind": "test", "description": "suite passes", "required": True}
                    ],
                    "model_route": {
                        "capability_tier": "advanced_coding",
                        "reasoning_effort": "high",
                        "policy_revision": "model-router.v1",
                    },
                    "execution_wave": 2,
                },
            }
            prompt = build_builder_prompt(config, task, run_id="run-1")

        self.assertIn(contract, prompt)
        self.assertIn("autodev/queue_import.py", prompt)
        self.assertIn("advanced_coding", prompt)
        self.assertIn("reasoning_effort: `high`", prompt)
        self.assertIn("suite passes", prompt)


if __name__ == "__main__":
    unittest.main()
