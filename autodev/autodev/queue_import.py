"""Validate and translate approved Issue Plans into AutoDev queue tasks.

This module is deliberately persistence-agnostic. YAML and database adapters
use the same strict validation, task translation, and receipt construction so
the HTTP boundary cannot create different queue semantics per backend.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import re
from typing import Any, Mapping, Sequence

from autodev._internal.time import now_iso


SCHEMA_VERSION = "autodev-queue-import.v1"
CAPABILITY_TIERS = frozenset(
    {"cost_optimized", "general_coding", "advanced_coding", "frontier"}
)
REASONING_EFFORTS = frozenset({"low", "medium", "high", "highest"})
EVIDENCE_KINDS = frozenset({"artifact", "test", "review", "commit", "push", "audit"})
ISSUE_KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9-]{0,63}$")
DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")

ROOT_FIELDS = frozenset(
    {"schemaVersion", "atomic", "issuePlanId", "planDigest", "tasks"}
)
TASK_FIELDS = frozenset(
    {
        "issueKey",
        "title",
        "goal",
        "developmentPrompt",
        "acceptance",
        "verify",
        "completionEvidence",
        "dependencies",
        "expectedFiles",
        "wave",
        "capabilityTier",
        "reasoningEffort",
        "routingPolicyRevision",
    }
)


class QueueImportError(RuntimeError):
    """Base error for the atomic import boundary."""


class QueueImportValidationError(QueueImportError, ValueError):
    """Raised before persistence when an import violates the contract."""


class QueueImportConflictError(QueueImportError):
    """Raised when an idempotency or plan identity is reused incompatibly."""


def _object(value: Any, name: str, fields: frozenset[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise QueueImportValidationError(f"{name} must be an object")
    unknown = sorted(set(value) - fields)
    missing = sorted(fields - set(value))
    if unknown:
        raise QueueImportValidationError(f"{name}.{unknown[0]} is not allowed")
    if missing:
        raise QueueImportValidationError(f"{name}.{missing[0]} is required")
    return value


def _text(value: Any, name: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise QueueImportValidationError(f"{name} must be a string")
    result = value.strip()
    if not result or len(result) > maximum:
        raise QueueImportValidationError(f"{name} must be non-blank and bounded")
    return result


def _texts(
    value: Any,
    name: str,
    *,
    maximum: int,
    item_maximum: int = 2_000,
) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise QueueImportValidationError(f"{name} must be a bounded string array")
    result = [
        _text(item, f"{name}[{index}]", item_maximum)
        for index, item in enumerate(value)
    ]
    if len(set(result)) != len(result):
        raise QueueImportValidationError(f"{name} must not contain duplicates")
    return result


def _validate_acyclic(tasks: Sequence[Mapping[str, Any]]) -> None:
    dependencies = {
        str(task["issue_key"]): list(task["dependencies"])
        for task in tasks
    }
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(issue_key: str) -> None:
        if issue_key in visiting:
            raise QueueImportValidationError("tasks.dependencies must not contain a cycle")
        if issue_key in visited:
            return
        visiting.add(issue_key)
        for dependency in dependencies[issue_key]:
            visit(dependency)
        visiting.remove(issue_key)
        visited.add(issue_key)

    for issue_key in dependencies:
        visit(issue_key)


def validate_import_request(value: Any) -> dict[str, Any]:
    """Return a canonical snake-case import document or fail before mutation."""
    root = _object(value, "import", ROOT_FIELDS)
    if root["schemaVersion"] != SCHEMA_VERSION:
        raise QueueImportValidationError(f"schemaVersion must be {SCHEMA_VERSION}")
    if root["atomic"] is not True:
        raise QueueImportValidationError("atomic must be true")
    issue_plan_id = _text(root["issuePlanId"], "issuePlanId", 255)
    plan_digest = _text(root["planDigest"], "planDigest", 64)
    if not DIGEST_PATTERN.fullmatch(plan_digest):
        raise QueueImportValidationError("planDigest must be a lowercase SHA-256 digest")
    raw_tasks = root["tasks"]
    if not isinstance(raw_tasks, list) or not raw_tasks or len(raw_tasks) > 100:
        raise QueueImportValidationError("tasks must be a non-empty bounded array")

    tasks: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_tasks):
        name = f"tasks[{index}]"
        task = _object(raw, name, TASK_FIELDS)
        issue_key = _text(task["issueKey"], f"{name}.issueKey", 64)
        if not ISSUE_KEY_PATTERN.fullmatch(issue_key):
            raise QueueImportValidationError(f"{name}.issueKey has an invalid format")
        acceptance_value = task["acceptance"]
        if not isinstance(acceptance_value, list) or len(acceptance_value) > 200:
            raise QueueImportValidationError(f"{name}.acceptance must be a bounded array")
        acceptance: list[dict[str, str]] = []
        for acceptance_index, raw_acceptance in enumerate(acceptance_value):
            accepted = _object(
                raw_acceptance,
                f"{name}.acceptance[{acceptance_index}]",
                frozenset({"criterionRef", "statement"}),
            )
            acceptance.append(
                {
                    "criterion_ref": _text(
                        accepted["criterionRef"],
                        f"{name}.acceptance[{acceptance_index}].criterionRef",
                        100,
                    ),
                    "statement": _text(
                        accepted["statement"],
                        f"{name}.acceptance[{acceptance_index}].statement",
                        4_000,
                    ),
                }
            )
        if len({item["criterion_ref"] for item in acceptance}) != len(acceptance):
            raise QueueImportValidationError(
                f"{name}.acceptance contains duplicate criterion refs"
            )

        evidence_value = task["completionEvidence"]
        if (
            not isinstance(evidence_value, list)
            or not evidence_value
            or len(evidence_value) > 50
        ):
            raise QueueImportValidationError(
                f"{name}.completionEvidence must be non-empty and bounded"
            )
        evidence: list[dict[str, Any]] = []
        for evidence_index, raw_evidence in enumerate(evidence_value):
            item_name = f"{name}.completionEvidence[{evidence_index}]"
            item = _object(
                raw_evidence,
                item_name,
                frozenset({"kind", "description", "required"}),
            )
            kind = _text(item["kind"], f"{item_name}.kind", 32)
            if kind not in EVIDENCE_KINDS or not isinstance(item["required"], bool):
                raise QueueImportValidationError(f"{item_name} is invalid")
            evidence.append(
                {
                    "kind": kind,
                    "description": _text(
                        item["description"], f"{item_name}.description", 2_000
                    ),
                    "required": item["required"],
                }
            )
        if not any(item["required"] for item in evidence):
            raise QueueImportValidationError(
                f"{name}.completionEvidence requires a mandatory item"
            )

        wave = task["wave"]
        if isinstance(wave, bool) or not isinstance(wave, int) or wave <= 0:
            raise QueueImportValidationError(f"{name}.wave must be a positive integer")
        capability_tier = _text(task["capabilityTier"], f"{name}.capabilityTier", 64)
        reasoning_effort = _text(task["reasoningEffort"], f"{name}.reasoningEffort", 64)
        if capability_tier not in CAPABILITY_TIERS:
            raise QueueImportValidationError(f"{name}.capabilityTier is unsupported")
        if reasoning_effort not in REASONING_EFFORTS:
            raise QueueImportValidationError(f"{name}.reasoningEffort is unsupported")
        verify = _texts(task["verify"], f"{name}.verify", maximum=50)
        if not verify:
            raise QueueImportValidationError(f"{name}.verify must be non-empty")
        development_prompt = _text(
            task["developmentPrompt"], f"{name}.developmentPrompt", 40_000
        )
        if len(development_prompt) < 80:
            raise QueueImportValidationError(
                f"{name}.developmentPrompt must be self-contained"
            )
        tasks.append(
            {
                "issue_key": issue_key,
                "title": _text(task["title"], f"{name}.title", 300),
                "goal": _text(task["goal"], f"{name}.goal", 4_000),
                "development_prompt": development_prompt,
                "acceptance": acceptance,
                "verify": verify,
                "completion_evidence": evidence,
                "dependencies": _texts(
                    task["dependencies"],
                    f"{name}.dependencies",
                    maximum=100,
                    item_maximum=64,
                ),
                "expected_files": _texts(
                    task["expectedFiles"],
                    f"{name}.expectedFiles",
                    maximum=500,
                ),
                "wave": wave,
                "capability_tier": capability_tier,
                "reasoning_effort": reasoning_effort,
                "routing_policy_revision": _text(
                    task["routingPolicyRevision"], f"{name}.routingPolicyRevision", 255
                ),
            }
        )

    issue_keys = [task["issue_key"] for task in tasks]
    if len(set(issue_keys)) != len(issue_keys):
        raise QueueImportValidationError("tasks.issueKey must be unique")
    known = set(issue_keys)
    waves = {task["issue_key"]: task["wave"] for task in tasks}
    for task in tasks:
        for dependency in task["dependencies"]:
            if dependency not in known:
                raise QueueImportValidationError(
                    f"unknown imported dependency for {task['issue_key']}: {dependency}"
                )
            if dependency == task["issue_key"]:
                raise QueueImportValidationError(
                    f"task cannot depend on itself: {task['issue_key']}"
                )
            if waves[dependency] >= task["wave"]:
                raise QueueImportValidationError(
                    f"dependency wave must precede {task['issue_key']}: {dependency}"
                )
    _validate_acyclic(tasks)
    return {
        "issue_plan_id": issue_plan_id,
        "plan_digest": plan_digest,
        "tasks": tasks,
    }


def validate_idempotency_key(value: Any) -> str:
    return _text(value, "idempotency-key", 255)


def import_id(issue_plan_id: str, plan_digest: str) -> str:
    identity = hashlib.sha256(f"{issue_plan_id}:{plan_digest}".encode()).hexdigest()
    return f"IMP-{identity[:24]}"


def validate_stored_receipt(
    receipt: Any,
    document: Mapping[str, Any],
    queue_tasks: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Fail closed if a persisted receipt no longer matches persisted tasks."""
    if not isinstance(receipt, dict) or set(receipt) != {
        "importId", "atomic", "planDigest", "tasks"
    }:
        raise QueueImportError("stored import receipt is invalid")
    if (
        receipt.get("importId")
        != import_id(document["issue_plan_id"], document["plan_digest"])
        or receipt.get("atomic") is not True
        or receipt.get("planDigest") != document["plan_digest"]
        or not isinstance(receipt.get("tasks"), list)
    ):
        raise QueueImportError("stored import receipt identity is invalid")
    expected_keys = [task["issue_key"] for task in document["tasks"]]
    mappings: dict[str, str] = {}
    for item in receipt["tasks"]:
        if not isinstance(item, dict) or set(item) != {"issueKey", "externalTaskId"}:
            raise QueueImportError("stored import task mapping is invalid")
        issue_key = item.get("issueKey")
        external_id = item.get("externalTaskId")
        if not isinstance(issue_key, str) or not isinstance(external_id, str):
            raise QueueImportError("stored import task mapping is invalid")
        if issue_key in mappings or external_id in mappings.values():
            raise QueueImportError("stored import task mapping contains duplicates")
        mappings[issue_key] = external_id
    if list(mappings) != expected_keys:
        raise QueueImportError("stored import receipt has incomplete task mappings")
    persisted_by_id = {str(task.get("id") or ""): task for task in queue_tasks}
    for issue_key, external_id in mappings.items():
        task = persisted_by_id.get(external_id)
        source = task.get("source") if isinstance(task, dict) else None
        if not isinstance(source, dict) or (
            source.get("issue_plan_id") != document["issue_plan_id"]
            or source.get("plan_digest") != document["plan_digest"]
            or source.get("issue_key") != issue_key
        ):
            raise QueueImportError("stored import receipt no longer matches Queue state")
    return deepcopy(receipt)


def allocate_task_ids(existing_tasks: Sequence[Mapping[str, Any]], count: int) -> list[str]:
    maximum = 0
    existing = {str(task.get("id") or "") for task in existing_tasks}
    for task_id in existing:
        if task_id.startswith("H-"):
            try:
                maximum = max(maximum, int(task_id[2:]))
            except ValueError:
                pass
    result: list[str] = []
    while len(result) < count:
        maximum += 1
        candidate = f"H-{maximum:03d}"
        if candidate not in existing:
            result.append(candidate)
    return result


def build_queue_tasks(
    document: Mapping[str, Any],
    existing_tasks: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Translate one fully validated document without mutating caller state."""
    timestamp = now_iso()
    task_ids = allocate_task_ids(existing_tasks, len(document["tasks"]))
    mapping = {
        task["issue_key"]: task_id
        for task, task_id in zip(document["tasks"], task_ids, strict=True)
    }
    tasks: list[dict[str, Any]] = []
    receipts: list[dict[str, str]] = []
    for imported, task_id in zip(document["tasks"], task_ids, strict=True):
        acceptance_contract = [
            {"criterionRef": item["criterion_ref"], "statement": item["statement"]}
            for item in imported["acceptance"]
        ]
        task = {
            "id": task_id,
            "title": imported["title"],
            "status": "pending",
            "priority": "P2",
            "area": "issue-plan",
            "goal": imported["goal"],
            "dependencies": [mapping[key] for key in imported["dependencies"]],
            "exclusive_resources": list(imported["expected_files"]),
            "acceptance": [
                f"[{item['criterion_ref']}] {item['statement']}"
                for item in imported["acceptance"]
            ],
            "acceptance_contract": acceptance_contract,
            "verify": list(imported["verify"]),
            "development_prompt": imported["development_prompt"],
            "completion_evidence": deepcopy(imported["completion_evidence"]),
            "expected_files": list(imported["expected_files"]),
            "execution_wave": imported["wave"],
            # P7 resolves a capability tier through the configured task-level
            # builder catalog. Keeping the selector on the imported task lets
            # AutoDev enforce that the requested builder exists and is writable.
            "preferred_builder": imported["capability_tier"],
            "model_route": {
                "capability_tier": imported["capability_tier"],
                "reasoning_effort": imported["reasoning_effort"],
                "policy_revision": imported["routing_policy_revision"],
            },
            "source": {
                "kind": "issue_plan",
                "issue_plan_id": document["issue_plan_id"],
                "plan_digest": document["plan_digest"],
                "issue_key": imported["issue_key"],
                "refs": [
                    f"issue-plan:{document['issue_plan_id']}",
                    f"issue:{imported['issue_key']}",
                ],
            },
            "artifacts": [],
            "notes": [
                {"at": timestamp, "text": "atomically imported from an approved Issue Plan"}
            ],
            "approved_by": "ai-dev-harness",
            "approved_at": timestamp,
            "revision": 1,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        tasks.append(task)
        receipts.append({"issueKey": imported["issue_key"], "externalTaskId": task_id})
    receipt = {
        "importId": import_id(document["issue_plan_id"], document["plan_digest"]),
        "atomic": True,
        "planDigest": document["plan_digest"],
        "tasks": receipts,
    }
    return tasks, receipt
