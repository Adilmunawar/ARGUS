#!/usr/bin/env python3
import hashlib
import json
import pathlib
import re
import subprocess
import sys

OWNER_NAME = "Adil Munawar"
OWNER_LOGIN = "Adilmunawar"
LICENSE_SHA256 = "f937f4d52e5ac7c27bb7cc792f131f0bfe2c6ab0d84e31f8d64fd8315f41e400"
RELICENSED_ON = "2026-11-01"

REQUIRED_TEXT = {
    "README.md": [
        "Copyright © 2026 Adil Munawar. **All rights reserved.**",
        "This repository is **not** open source",
        "Built and maintained by **[Adil Munawar](https://github.com/Adilmunawar)**",
    ],
    "CONTRIBUTING.md": ["Argus is not open source."],
    "CITATION.cff": ["family-names: Munawar", "given-names: Adil"],
    ".github/CODEOWNERS": ["* @Adilmunawar"],
}

MANIFESTS = ["package.json", "platform/console/server/package.json"]


def fail(message):
    print(f"::error::{message}")
    return 1


def check_license():
    path = pathlib.Path("LICENSE")
    if not path.is_file():
        return fail("LICENSE is missing")
    digest = hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
    if digest != LICENSE_SHA256:
        return fail(
            "LICENSE has been changed. Only the owner may change it, and the pinned "
            "hash in .github/scripts/check-ownership.py must be updated in the same commit."
        )
    return 0


def check_text():
    failures = 0
    for name, needles in REQUIRED_TEXT.items():
        path = pathlib.Path(name)
        if not path.is_file():
            failures += fail(f"{name} is missing")
            continue
        text = path.read_text(encoding="utf-8")
        for needle in needles:
            if needle not in text:
                failures += fail(f"{name} no longer contains the required ownership text: {needle!r}")
    return failures


def check_manifests():
    failures = 0
    for name in MANIFESTS:
        data = json.loads(pathlib.Path(name).read_text(encoding="utf-8"))
        if data.get("license") != "UNLICENSED":
            failures += fail(f'{name} must declare "license": "UNLICENSED"')
        if data.get("private") is not True:
            failures += fail(f'{name} must declare "private": true')
    return failures


def check_commits():
    out = subprocess.run(
        ["git", "log", f"--since={RELICENSED_ON}", "--format=%H%x00%an%x00%ae%x00%B%x01"],
        capture_output=True, text=True, check=True,
    ).stdout
    failures = 0
    for record in filter(None, out.split("\x01")):
        sha, author, email, body = record.strip("\n").split("\x00", 3)
        if author.strip() != OWNER_NAME:
            failures += fail(f"commit {sha[:12]} is authored by {author!r}; only {OWNER_NAME} may author commits")
        if re.search(r"^\s*co-authored-by\s*:", body, re.IGNORECASE | re.MULTILINE):
            failures += fail(f"commit {sha[:12]} carries a Co-authored-by trailer; this repository has one author")
    return failures


def main():
    failures = check_license() + check_text() + check_manifests() + check_commits()
    if failures:
        print(f"{failures} ownership invariant(s) violated. See LICENSE: use and changes need the owner's written permission.")
        return 1
    print(f"clean: licence intact, ownership text present, every commit since {RELICENSED_ON} authored by {OWNER_NAME}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
