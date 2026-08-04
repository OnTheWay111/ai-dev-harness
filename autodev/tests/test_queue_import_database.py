from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from sqlalchemy import create_engine, select
from sqlalchemy.pool import StaticPool

from autodev.database.engine import Database
from autodev.database.models import Base, ImportBatch, QueueTask
from autodev.database.queue_repository import DatabaseQueuePort, DatabaseQueueRepository
from autodev.database.run_repository import ProjectIdentity
from autodev.queue_import import build_queue_tasks, validate_import_request
from tests.test_queue_import import import_payload


class DatabaseQueueImportTests(unittest.TestCase):
    def setUp(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.database = Database(engine)
        self.addCleanup(self.database.dispose)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        identity = ProjectIdentity.local("queue-import-test", Path(self.temporary.name))
        self.repository = DatabaseQueueRepository(self.database, identity)
        self.repository.import_manifest(
            {"schema_version": 1, "policy": {}, "tasks": []},
            source_uri="test://empty",
        )
        self.port = DatabaseQueuePort(self.repository)

    def test_tasks_and_completed_receipt_commit_in_one_transaction(self) -> None:
        result = self.port.import_plan(import_payload(), idempotency_key="projection-1")
        self.assertTrue(result.ok)
        self.assertEqual(result.receipt["tasks"][1]["externalTaskId"], "H-002")

        replay = self.port.import_plan(import_payload(), idempotency_key="projection-2")
        self.assertEqual(replay.receipt, result.receipt)
        with self.database.unit_of_work() as session:
            tasks = session.scalars(select(QueueTask)).all()
            batches = session.scalars(select(ImportBatch)).all()
        self.assertEqual(len(tasks), 2)
        self.assertEqual(len(batches), 2)
        self.assertTrue(all(batch.status == "completed" for batch in batches))
        self.assertEqual(batches[1].summary["alias_of"], "projection-1")

        conflict = import_payload()
        conflict["issuePlanId"] = "00000000-0000-4000-8000-000000000099"
        conflict["planDigest"] = "9" * 64
        rejected = self.port.import_plan(conflict, idempotency_key="projection-2")
        self.assertFalse(rejected.ok)
        self.assertEqual(rejected.status, "idempotency_conflict")

    def test_failed_batch_rolls_back_tasks_and_receipt(self) -> None:
        invalid = import_payload()
        invalid["tasks"][1]["dependencies"] = ["MISSING"]
        result = self.port.import_plan(invalid, idempotency_key="projection-invalid")
        self.assertFalse(result.ok)
        self.assertEqual(result.status, "invalid_import")
        with self.database.unit_of_work() as session:
            self.assertEqual(len(session.scalars(select(QueueTask)).all()), 0)
            self.assertEqual(len(session.scalars(select(ImportBatch)).all()), 0)

    def test_cutover_queue_tasks_recover_the_receipt_without_duplicates(self) -> None:
        document = validate_import_request(import_payload())
        tasks, expected = build_queue_tasks(document, [])
        self.repository.import_manifest(
            {"schema_version": 1, "policy": {}, "tasks": tasks},
            source_uri="test://yaml-cutover",
        )

        result = self.port.import_plan(import_payload(), idempotency_key="after-cutover")
        self.assertTrue(result.ok)
        self.assertEqual(result.receipt, expected)
        with self.database.unit_of_work() as session:
            self.assertEqual(len(session.scalars(select(QueueTask)).all()), 2)
            batch = session.scalar(select(ImportBatch))
        self.assertTrue(batch.summary["recovered_from_queue"])


if __name__ == "__main__":
    unittest.main()
