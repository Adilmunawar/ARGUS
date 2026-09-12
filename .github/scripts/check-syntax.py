#!/usr/bin/env python3
import pathlib
import re
import sys

import hcl2
import pglast

PSQL_META = re.compile(r"^\s*\\")
PSQL_TERMINATOR = re.compile(r"^\s*\\g(?:exec|set|x)?\b|^\s*\\crosstabview\b")
PSQL_VAR = re.compile(r"\A:(?:'[A-Za-z_][A-Za-z0-9_]*'|\"[A-Za-z_][A-Za-z0-9_]*\"|[A-Za-z_][A-Za-z0-9_]*)")
DOLLAR_TAG = re.compile(r"\A\$[A-Za-z_][A-Za-z0-9_]*\$|\A\$\$")
SKIP_PARTS = {"node_modules", ".git"}
ROOTS = ["platform", ".github"]


def files(suffixes):
    for root in ROOTS:
        for path in sorted(pathlib.Path(root).rglob("*")):
            if path.is_file() and path.suffix in suffixes and not SKIP_PARTS & set(path.parts):
                yield path


def substitute_variables(text):
    out = []
    i = 0
    while i < len(text):
        rest = text[i:]
        tag = DOLLAR_TAG.match(rest)
        if tag:
            marker = tag.group(0)
            end = text.find(marker, i + len(marker))
            end = len(text) if end == -1 else end + len(marker)
            out.append(text[i:end])
            i = end
            continue
        char = text[i]
        if char == "'":
            j = i + 1
            while j < len(text):
                if text[j] == "'":
                    if j + 1 < len(text) and text[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            out.append(text[i:j + 1])
            i = j + 1
            continue
        if char == '"':
            j = text.find('"', i + 1)
            j = len(text) - 1 if j == -1 else j
            out.append(text[i:j + 1])
            i = j + 1
            continue
        if char == ":" and not (out and out[-1].endswith(":")):
            match = PSQL_VAR.match(rest)
            if match:
                out.append("'psql_variable'")
                i += len(match.group(0))
                continue
        out.append(char)
        i += 1
    return "".join(out)


def sql_body(text):
    lines = []
    for line in text.splitlines():
        if PSQL_TERMINATOR.match(line):
            lines.append(";")
        elif not PSQL_META.match(line):
            lines.append(line)
    return substitute_variables("\n".join(lines))


def check_sql():
    bad = 0
    checked = 0
    for path in files({".sql"}):
        checked += 1
        try:
            pglast.parse_sql(sql_body(path.read_text(encoding="utf-8")))
        except Exception as error:
            print(f"::error file={path}::is not valid PostgreSQL: {str(error)[:160]}")
            bad += 1
    print(f"{checked - bad}/{checked} SQL files parse as PostgreSQL")
    return bad


def check_hcl():
    bad = 0
    checked = 0
    for path in files({".hcl", ".tf"}):
        checked += 1
        try:
            with path.open(encoding="utf-8") as handle:
                hcl2.load(handle)
        except Exception as error:
            print(f"::error file={path}::is not valid HCL: {str(error)[:160]}")
            bad += 1
    print(f"{checked - bad}/{checked} HCL files parse")
    return bad


def main():
    bad = check_sql() + check_hcl()
    if bad:
        print(f"{bad} file(s) would be rejected by the tool that has to read them.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
