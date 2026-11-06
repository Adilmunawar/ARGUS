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
RELICENSED_AT = "057335b1f3c1fd2c00fbde20b83b1174c451c297"

REQUIRED_TEXT = {
    "README.md": [
        "Copyright © 2026 Adil Munawar. **All rights reserved.**",
        "This repository is **not** open source",
        "Built and maintained by **[Adil Munawar](https://github.com/Adilmunawar)**",
    ],
    "CONTRIBUTING.md": ["Argus is not open source."],
    "CITATION.cff": ["family-names: Munawar", "given-names: Adil"],
    ".github/CODEOWNERS": ["* @Adilmunawar"],
    "USE-POLICY.md": ["Argus is published so it can be read. It is not open source."],
    "TRADEMARK.md": ["are used by Adil Munawar to identify this project"],
    "ENFORCEMENT.md": ["I am Adil Munawar, the author and copyright owner"],
}

MANIFESTS = ["package.json", "platform/console/server/package.json"]

DEPENDABOT_EMAIL = "49699333+dependabot[bot]@users.noreply.github.com"

DEPENDABOT_FILES = re.compile(
    r"^(?:"
    r"(?:[^/]+/)*(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|Dockerfile)"
    r"|\.github/workflows/[^/]+\.ya?ml"
    r"|\.github/requirements-ci\.txt"
    r"|platform/compose/docker-compose(?:\.[a-z0-9-]+)?\.ya?ml"
    r")$"
)

CO_AUTHOR = re.compile(r"^\s*co-authored-by\s*:", re.IGNORECASE | re.MULTILINE)

FIELD = "\x00"
RECORD = "\x01"


def fail(message):
    print(f"::error::{message}")
    return 1


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


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


def parse_log(out):
    records = []
    malformed = []
    for chunk in out.split(RECORD):
        chunk = chunk.strip("\n")
        if not chunk:
            continue
        parts = chunk.split(FIELD, 3)
        if len(parts) != 4:
            malformed.append(chunk[:60])
            continue
        records.append(tuple(parts))
    return records, malformed


def judge(sha, author, email, body, files):
    problems = []
    if author.strip() == OWNER_NAME:
        pass
    elif email.strip() == DEPENDABOT_EMAIL:
        outside = sorted(name for name in files if not DEPENDABOT_FILES.match(name))
        if not files:
            problems.append(
                f"commit {sha[:12]} is authored by Dependabot and changes no file, so it cannot be "
                "shown to be a dependency update"
            )
        elif outside:
            problems.append(
                f"commit {sha[:12]} is authored by Dependabot but changes {', '.join(outside[:5])}; "
                "a Dependabot commit may change only manifests, lockfiles and workflows"
            )
    else:
        problems.append(f"commit {sha[:12]} is authored by {author!r}; only {OWNER_NAME} may author commits")
    if CO_AUTHOR.search(body):
        problems.append(f"commit {sha[:12]} carries a Co-authored-by trailer; this repository has one author")
    return problems


def changed_files(sha):
    parents = git("rev-list", "--parents", "-n", "1", sha).split()[1:]
    if parents:
        out = git("diff", "--name-only", "--no-renames", "-z", parents[0], sha)
    else:
        out = git("diff-tree", "--root", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", sha)
    return [name for name in out.split("\x00") if name]


def check_commits():
    try:
        git("cat-file", "-e", f"{RELICENSED_AT}^{{commit}}")
    except subprocess.CalledProcessError:
        return fail(
            f"the relicensing commit {RELICENSED_AT[:12]} is not in this checkout. Fetch the full history "
            "(actions/checkout with fetch-depth: 0), or, if history was rewritten, update RELICENSED_AT."
        )
    out = git("log", "--format=%H%x00%an%x00%ae%x00%B%x01", f"{RELICENSED_AT}^..HEAD")
    records, malformed = parse_log(out)
    failures = 0
    for chunk in malformed:
        failures += fail(f"git log produced a record that could not be read: {chunk!r}")
    for sha, author, email, body in records:
        files = [] if author.strip() == OWNER_NAME else changed_files(sha)
        for problem in judge(sha, author, email, body, files):
            failures += fail(problem)
    return failures


SAMPLE_EMAIL = "owner@example.com"

SELF_TEST_LOG = (
    "a" * 40 + FIELD + OWNER_NAME + FIELD + SAMPLE_EMAIL + FIELD + "First\n" + RECORD + "\n"
    + "b" * 40 + FIELD + OWNER_NAME + FIELD + SAMPLE_EMAIL + FIELD + "Second\n\nBody\n" + RECORD + "\n"
)

SELF_TEST_JUDGE = [
    ("the owner", (OWNER_NAME, SAMPLE_EMAIL, "Fix\n", []), True),
    ("the owner with a co-author",
     (OWNER_NAME, SAMPLE_EMAIL, "Fix\n\nCo-authored-by: x <x@example.com>\n", []), False),
    ("the owner with an indented lower-case co-author",
     (OWNER_NAME, SAMPLE_EMAIL, "Fix\n\n  co-authored-by : x\n", []), False),
    ("another person", ("Someone Else", "someone@example.com", "Fix\n", ["README.md"]), False),
    ("Dependabot bumping a manifest and its lockfile",
     ("dependabot[bot]", DEPENDABOT_EMAIL, "Bump\n", ["package.json", "package-lock.json"]), True),
    ("Dependabot bumping a nested lockfile",
     ("dependabot[bot]", DEPENDABOT_EMAIL, "Bump\n", ["platform/console/server/package-lock.json"]), True),
    ("Dependabot bumping workflow actions",
     ("dependabot[bot]", DEPENDABOT_EMAIL, "Bump\n", [".github/workflows/validate.yml"]), True),
    ("Dependabot bumping a base image",
     ("dependabot[bot]", DEPENDABOT_EMAIL, "Bump\n", ["platform/console/server/Dockerfile"]), True),
    ("Dependabot bumping compose and pip pins",
     ("dependabot[bot]", DEPENDABOT_EMAIL, "Bump\n",
      ["platform/compose/docker-compose.yml", "platform/compose/docker-compose.ports.yml",
       ".github/requirements-ci.txt"]), True),
    ("Dependabot touching a script",
     ("dependabot[bot]", DEPENDABOT_EMAIL, "Bump\n", ["package.json", ".github/scripts/check-ownership.py"]), False),
    ("Dependabot touching a look-alike file",
     ("dependabot[bot]", DEPENDABOT_EMAIL, "Bump\n", ["package.json.sh"]), False),
    ("Dependabot touching a file below the workflows folder",
     ("dependabot[bot]", DEPENDABOT_EMAIL, "Bump\n", [".github/workflows/scripts/run.yml"]), False),
    ("Dependabot touching the licence",
     ("dependabot[bot]", DEPENDABOT_EMAIL, "Bump\n", ["package-lock.json", "LICENSE"]), False),
    ("Dependabot changing nothing", ("dependabot[bot]", DEPENDABOT_EMAIL, "Bump\n", []), False),
    ("Dependabot with a co-author",
     ("dependabot[bot]", DEPENDABOT_EMAIL, "Bump\n\nCo-authored-by: x <x@example.com>\n", ["package.json"]), False),
    ("the Dependabot name with another email",
     ("dependabot[bot]", "dependabot@example.com", "Bump\n", ["package.json"]), False),
]


def self_test():
    failures = []
    records, malformed = parse_log(SELF_TEST_LOG)
    if len(records) != 2 or malformed:
        failures.append(f"read {len(records)} record(s) and {len(malformed)} malformed one(s) from a two-commit log")
    records, malformed = parse_log("c" * 40 + FIELD + "only two fields" + RECORD + "\n")
    if records or len(malformed) != 1:
        failures.append("did not report a record with missing fields")
    records, malformed = parse_log("")
    if records or malformed:
        failures.append("did not accept an empty log")
    for name, (author, email, body, files), allowed in SELF_TEST_JUDGE:
        verdict = not judge("d" * 40, author, email, body, files)
        if verdict != allowed:
            failures.append(f"{'rejected' if allowed else 'accepted'} a commit by {name}")
    for failure in failures:
        print(f"self-test: {failure}")
    total = 3 + len(SELF_TEST_JUDGE)
    print(f"self-test: {total - len(failures)}/{total} ownership samples judged correctly")
    return 1 if failures else 0


def main():
    if "--self-test" in sys.argv:
        return self_test()
    if self_test():
        print("::error::the ownership checker failed its own self-test")
        return 2
    failures = check_license() + check_text() + check_manifests() + check_commits()
    if failures:
        print(f"{failures} ownership invariant(s) violated. See LICENSE: use and changes need the owner's written permission.")
        return 1
    print(f"clean: licence intact, ownership text present, every commit since {RELICENSED_AT[:12]} is by "
          f"{OWNER_NAME} or is a Dependabot dependency update")
    return 0


if __name__ == "__main__":
    sys.exit(main())
