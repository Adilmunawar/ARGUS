#!/usr/bin/env python3
import os
import pathlib
import re
import sys

import yaml

GENERATED_PREFIXES = ("./secrets/", "../console/server/node_modules")


def load(path):
    with open(path, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def sources(service):
    for volume in service.get("volumes") or []:
        if isinstance(volume, str):
            head = volume.split(":", 1)[0]
            if head.startswith("."):
                yield head
        elif isinstance(volume, dict):
            source = volume.get("source", "")
            if volume.get("type") == "bind" and source.startswith("."):
                yield source


def profile_gaps(services):
    gaps = []
    for name, service in services.items():
        if not isinstance(service, dict):
            continue
        mine = set(service.get("profiles") or [])
        if not mine:
            continue
        for dependency in (service.get("depends_on") or {}):
            theirs = set((services.get(dependency) or {}).get("profiles") or [])
            if theirs and not mine <= theirs:
                gaps.append((name, sorted(mine), dependency, sorted(mine - theirs)))
    return gaps


def main():
    compose_path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "platform/compose/docker-compose.yml")
    root = compose_path.parent
    document = load(compose_path)
    services = document.get("services") or {}

    missing = []
    generated = []
    for name, service in services.items():
        if not isinstance(service, dict):
            continue
        for source in sources(service):
            target = (root / source).resolve()
            if source.startswith(GENERATED_PREFIXES):
                if not target.exists():
                    generated.append((name, source))
                continue
            if not target.exists():
                missing.append((name, source))

    for name, source in sorted(set(missing)):
        print(f"::error file={compose_path}::service \"{name}\" bind-mounts {source}, which does not exist in the repository")
    for name, source in sorted(set(generated)):
        print(f"  generated at runtime, not checked: {name} -> {source}")

    gaps = profile_gaps(services)
    for name, mine, dependency, absent in gaps:
        print(f"::error file={compose_path}::service \"{name}\" is in {mine} and depends on \"{dependency}\", "
              f"which is not enabled by {absent}, so those profiles cannot start on their own")

    if missing:
        print(f"{len(set(missing))} bind mount(s) point at paths that are not in the repository.")
        print("Docker would create an empty directory at each and the service would start unconfigured or crash-loop.")
    if gaps:
        print(f"{len(gaps)} dependency(ies) cross a profile boundary without the dependency joining that profile.")
    if missing or gaps:
        return 1
    print(f"clean: every bind mount in {len(services)} services resolves to a committed path, "
          f"and every profile can start on its own")
    return 0


if __name__ == "__main__":
    sys.exit(main())
