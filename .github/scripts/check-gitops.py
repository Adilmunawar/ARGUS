#!/usr/bin/env python3
import json
import pathlib
import sys

import jsonschema
import yaml

SPEC_ROOTS = ["platform/gitops", "platform/policies"]
SCHEMA_ROOT = pathlib.Path("platform/gitops/schemas")
SKIP_PARTS = {"node_modules", ".git", "schemas"}


def load_schemas():
    schemas = {}
    for path in sorted(SCHEMA_ROOT.glob("*.schema.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        kind = (document.get("properties", {}).get("kind", {}).get("const")
                or document.get("title") or path.stem.split(".")[0])
        schemas[kind] = (path, document)
    return schemas


def spec_files():
    for root in SPEC_ROOTS:
        for path in sorted(pathlib.Path(root).rglob("*.yaml")):
            if SKIP_PARTS & set(path.parts):
                continue
            yield path
        for path in sorted(pathlib.Path(root).rglob("*.yml")):
            if SKIP_PARTS & set(path.parts):
                continue
            yield path


def main():
    schemas = load_schemas()
    for kind, (path, document) in schemas.items():
        try:
            jsonschema.Draft202012Validator.check_schema(document)
        except jsonschema.SchemaError as error:
            print(f"::error file={path}::is not a valid JSON Schema 2020-12 document: {error.message}")
            return 1

    bad = 0
    validated = 0
    uncovered = []
    for path in spec_files():
        try:
            document = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception as error:
            print(f"::error file={path}::does not parse: {error}")
            bad += 1
            continue
        if not isinstance(document, dict):
            continue
        kind = document.get("kind")
        if not kind:
            continue
        if kind not in schemas:
            uncovered.append((path, kind))
            continue
        schema_path, schema = schemas[kind]
        errors = sorted(
            jsonschema.Draft202012Validator(schema).iter_errors(document),
            key=lambda e: list(e.path),
        )
        if errors:
            for error in errors:
                location = "/".join(str(part) for part in error.path) or "(root)"
                print(f"::error file={path}::{location}: {error.message}")
            bad += 1
        else:
            validated += 1

    for path, kind in uncovered:
        print(f"  no schema for kind \"{kind}\": {path}")
    print(f"{validated} spec(s) validated against {len(schemas)} schema(s), {len(uncovered)} kind(s) uncovered")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
