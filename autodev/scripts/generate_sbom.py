"""Generate a bounded CycloneDX inventory from the active AutoDev environment."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
from uuid import uuid4


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.output.is_absolute() or args.output.suffix != ".json":
        raise SystemExit("--output must be an absolute JSON path")

    components = []
    for distribution in sorted(metadata.distributions(), key=lambda item: item.metadata["Name"].lower()):
        name = distribution.metadata["Name"]
        version = distribution.version
        if not name or not version:
            continue
        license_expression = (
            distribution.metadata.get("License-Expression")
            or distribution.metadata.get("License")
            or "NOASSERTION"
        )
        components.append({
            "type": "library",
            "name": name,
            "version": version,
            "purl": f"pkg:pypi/{name.lower().replace('_', '-')}@{version}",
            "licenses": [{"expression": license_expression}],
        })
    document = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "serialNumber": f"urn:uuid:{uuid4()}",
        "version": 1,
        "metadata": {
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "component": {
                "type": "application",
                "name": "autodev-harness",
                "version": metadata.version("autodev-harness"),
            },
        },
        "components": components,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(f"Generated Python SBOM with {len(components)} components")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
