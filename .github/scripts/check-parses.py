#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys

import yaml

ROOTS = ["platform", ".github"]
SKIP_PARTS = {"node_modules", ".git"}


BINARY_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2",
                   ".pdf", ".zip", ".gz", ".tar", ".exe", ".dll", ".pfx", ".p12"}


def check_no_nul():
    listing = subprocess.run(
        ["git", "ls-files", "-z"], capture_output=True, text=True, check=True
    ).stdout
    bad = 0
    for name in listing.split(chr(0)):
        if not name or pathlib.Path(name).suffix.lower() in BINARY_SUFFIXES:
            continue
        try:
            data = pathlib.Path(name).read_bytes()
        except (FileNotFoundError, IsADirectoryError):
            continue
        count = data.count(bytes([0]))
        if count:
            line = data[: data.index(bytes([0]))].count(b"\n") + 1
            print(
                f"::error file={name},line={line}::contains {count} literal NUL byte(s). "
                "Git treats the whole file as binary, so it loses diff, blame and merge. "
                "Write the escape instead."
            )
            bad += 1
    return bad


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
    nul = check_no_nul()
    if not nul:
        print("clean: no tracked text file carries a literal NUL byte")
    return 1 if (bad + nul) else 0


if __name__ == "__main__":
    sys.exit(main())
