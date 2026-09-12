#!/usr/bin/env python3
import json
import pathlib
import re
import sys

import regress

SCHEMA_ROOT = pathlib.Path("platform/gitops/schemas")

NOT_IN_ECMA = [
    (re.compile(r"\(\?[aiLmsuxt]+[-\w]*\)"), "an inline flag group, which ECMA-262 has no syntax for"),
    (re.compile(r"\(\?P[<=]"), "a Python-spelled named group, which ECMA-262 spells (?<name>)"),
    (re.compile(r"\\[AZz]"), "a Python string anchor, which ECMA-262 spells ^ and $"),
    (re.compile(r"[*+?}]\+"), "a possessive quantifier, which ECMA-262 lacks"),
    (re.compile(r"\(\?#"), "an inline comment group, which ECMA-262 lacks"),
]

SELF_TEST_REJECT = [
    "(?i)^argus$",
    "(?P<name>x)",
    r"\Aargus\Z",
    "a++",
    "(?#note)a",
    "[a-",
]

SELF_TEST_ACCEPT = [
    r"^\{\{ *openbao:[A-Za-z0-9/_.:-]+ *\}\}$",
    "^gmsa-[a-z0-9-]+\\$$",
    "^[A-Za-z_][A-Za-z0-9_]*$",
    "^(?!.*(?:password|secret)=)[^=]+$",
    "(?<=x)y",
]


def patterns(node, pointer=""):
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{pointer}/{key}"
            if key == "pattern" and isinstance(value, str):
                yield here, value
            elif key == "patternProperties" and isinstance(value, dict):
                for name, subschema in value.items():
                    yield f"{here}/{name}", name
                    yield from patterns(subschema, f"{here}/{name}")
            else:
                yield from patterns(value, here)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from patterns(value, f"{pointer}/{index}")


def faults(pattern):
    found = []
    for probe, why in NOT_IN_ECMA:
        if probe.search(pattern):
            found.append(why)
    try:
        regress.Regex(pattern, flags="u")
    except regress.RegressError as error:
        found.append(f"regress rejects it as ECMA-262: {error}")
    try:
        re.compile(pattern)
    except re.error as error:
        found.append(f"Python re rejects it: {error}")
    return found


def self_test():
    failures = []
    for pattern in SELF_TEST_REJECT:
        if not faults(pattern):
            failures.append(("accepted a pattern it must reject", pattern))
    for pattern in SELF_TEST_ACCEPT:
        problems = faults(pattern)
        if problems:
            failures.append((f"rejected a valid pattern: {problems}", pattern))
    for why, pattern in failures:
        print(f"self-test: {why}: {pattern!r}")
    total = len(SELF_TEST_REJECT) + len(SELF_TEST_ACCEPT)
    print(f"self-test: {total - len(failures)}/{total} dialect samples judged correctly")
    return 1 if failures else 0


def main():
    if "--self-test" in sys.argv:
        return self_test()
    if self_test():
        print("::error::the pattern dialect checker failed its own self-test")
        return 2
    bad = 0
    total = 0
    schemas = sorted(SCHEMA_ROOT.glob("*.schema.json"))
    if not schemas:
        print(f"::error::no schemas found under {SCHEMA_ROOT}")
        return 1
    for path in schemas:
        document = json.loads(path.read_text(encoding="utf-8"))
        for pointer, pattern in patterns(document):
            total += 1
            problems = faults(pattern)
            for why in problems:
                print(f"::error file={path}::{pointer} is not portable: {why}")
            bad += 1 if problems else 0
    if not total:
        print(f"::error::no patterns found in {len(schemas)} schema(s); the walker is broken")
        return 1
    print(f"{total - bad}/{total} schema pattern(s) are ECMA-262 and Python regular expressions")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
