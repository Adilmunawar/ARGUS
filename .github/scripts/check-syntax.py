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


META_ARGS = {"source", "version", "count", "for_each", "providers", "depends_on", "lifecycle",
             "__comments__", "__is_block__", "__start_line__", "__end_line__"}


def unquote(value):
    if isinstance(value, str) and len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def module_variables(directory):
    declared = {}
    for path in sorted(directory.glob("*.tf")):
        try:
            with path.open(encoding="utf-8") as handle:
                document = hcl2.load(handle)
        except Exception:
            continue
        for block in document.get("variable", []):
            for name, body in block.items():
                declared[unquote(name)] = "default" in body
    return declared


def check_terraform_modules():
    bad = 0
    checked = 0
    for path in files({".tf"}):
        try:
            with path.open(encoding="utf-8") as handle:
                document = hcl2.load(handle)
        except Exception:
            continue
        for block in document.get("module", []):
            for raw_label, body in block.items():
                label = unquote(raw_label)
                source = unquote(body.get("source", ""))
                if not isinstance(source, str) or not source.startswith("."):
                    continue
                checked += 1
                target = (path.parent / source).resolve()
                if not target.is_dir():
                    print(f"::error file={path}::module \"{label}\" has source {source}, which is not a directory")
                    bad += 1
                    continue
                declared = module_variables(target)
                if not declared:
                    print(f"::error file={path}::module \"{label}\" source {source} declares no variables")
                    bad += 1
                    continue
                passed = {k for k in body if k not in META_ARGS}
                unknown = sorted(passed - set(declared))
                missing = sorted(n for n, has_default in declared.items() if not has_default and n not in passed)
                for name in unknown:
                    print(f"::error file={path}::module \"{label}\" passes {name}, which {source} does not declare")
                    bad += 1
                for name in missing:
                    print(f"::error file={path}::module \"{label}\" does not pass {name}, which {source} requires")
                    bad += 1
    print(f"{checked} local Terraform module call(s) match their module's variables")
    return bad


def main():
    bad = check_sql() + check_hcl() + check_terraform_modules()
    if bad:
        print(f"{bad} file(s) would be rejected by the tool that has to read them.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
