#!/usr/bin/env python3
import pathlib
import re
import sys

ROOT = pathlib.Path("platform/console/prototype")
EXTERNAL = re.compile(
    r"""(?:src|href|url|from|import|connect|fetch)\s*[=(:]?\s*['"(]?"""
    r"""(https?:)?//(?!localhost|127\.0\.0\.1)[A-Za-z0-9.-]+\.[A-Za-z]{2,}""",
    re.IGNORECASE,
)
BARE_HOST = re.compile(
    r"https?://(?!localhost|127\.0\.0\.1)[A-Za-z0-9.-]+\.[A-Za-z]{2,}", re.IGNORECASE
)
ALLOWED = re.compile(r"xmlns|w3\.org|schema\.org|\.local\b|\.internal\b|\.lan\b|\.home\.arpa\b|\.svc\b")
SUFFIXES = (".html", ".js", ".css")


def main():
    findings = []
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or path.suffix not in SUFFIXES or "tests" in path.parts:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if ALLOWED.search(line):
                continue
            match = EXTERNAL.search(line) or BARE_HOST.search(line)
            if match:
                findings.append((path, number, match.group(0)[:60]))

    for path, number, detail in findings:
        print(f"::error file={path},line={number}::the console must fetch nothing external: {detail}")
    if findings:
        print("The console runs behind an egress allow-list and must ship every asset it needs.")
        return 1
    print("clean: the console bundle references no external origin")
    return 0


if __name__ == "__main__":
    sys.exit(main())
