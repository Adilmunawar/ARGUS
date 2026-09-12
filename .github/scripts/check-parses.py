#!/usr/bin/env python3
import json
import pathlib
import sys

import yaml

ROOTS = ["platform", ".github"]
SKIP_PARTS = {"node_modules", ".git"}


def main():
    bad = 0
    checked = 0
    for root in ROOTS:
        for path in sorted(pathlib.Path(root).rglob("*")):
            if not path.is_file() or SKIP_PARTS & set(path.parts):
                continue
            if path.suffix not in (".yaml", ".yml", ".json"):
                continue
            checked += 1
            try:
                text = path.read_text(encoding="utf-8")
                if path.suffix == ".json":
                    json.loads(text)
                else:
                    list(yaml.safe_load_all(text))
            except Exception as error:
                print(f"::error file={path}::does not parse: {error}")
                bad += 1
    print(f"{checked - bad}/{checked} YAML and JSON files parse")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
