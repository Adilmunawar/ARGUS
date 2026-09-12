#!/usr/bin/env python3
import pathlib
import re
import subprocess
import sys

import yaml

HASH = "#"
DASH = "--"
SLASH = "//"

KEEP_LINE = re.compile(
    r"^\s*(?:#!|#\s*requires|#\s*syntax\s*=|#\s*escape\s*=|#\s*checkov|#\s*noqa|#\s*type:)",
    re.IGNORECASE,
)

BLOCK = {
    ".jsonc": ("/*", "*/"),
    ".ps1": ("<#", "#>"),
    ".psm1": ("<#", "#>"),
    ".psd1": ("<#", "#>"),
    ".sql": ("/*", "*/"),
    ".hcl": ("/*", "*/"),
    ".tf": ("/*", "*/"),
    ".css": ("/*", "*/"),
    ".java": ("/*", "*/"),
    ".alloy": ("/*", "*/"),
}

MARKERS = {
    ".yml": [HASH], ".yaml": [HASH], ".sh": [HASH], ".bash": [HASH],
    ".conf": [HASH], ".hcl": [HASH, SLASH], ".tf": [HASH, SLASH], ".toml": [HASH],
    ".ps1": [HASH], ".psm1": [HASH], ".psd1": [HASH], ".sql": [DASH],
    ".example": [HASH], ".gitignore": [HASH], ".gitattributes": [HASH],
    ".dockerignore": [HASH], ".css": [], ".jsonc": [SLASH],
    ".java": [SLASH], ".alloy": [SLASH], ".tmpl": [HASH],
}

SHELL_LIKE = {".sh", ".bash", ".conf", ".yml", ".yaml", ".ps1", ".psm1", ".psd1", ".example",
              ".gitignore", ".gitattributes", ".dockerignore", ".toml", "Dockerfile"}


BLOCK_SCALAR = re.compile(r"^(\s*)(?:-\s+)?(?:[\w.$-]+\s*:\s*)?[|>][-+]?\d*\s*$")


def suffix_of(path):
    name = pathlib.Path(path).name
    if name.startswith("Dockerfile"):
        return "Dockerfile"
    if name.startswith(".env"):
        return ".example"
    if name == "garnet.conf":
        return ".jsonc"
    return pathlib.Path(path).suffix.lower()


def markers_for(suffix):
    if suffix == "Dockerfile":
        return [HASH]
    return MARKERS.get(suffix, [])


def marker_index(line, markers, suffix, shell_rules=True):
    in_single = in_double = in_backtick = False
    i = 0
    while i < len(line):
        char = line[i]
        if char == "\\" and suffix not in (".yml", ".yaml"):
            i += 2
            continue
        if char == "'" and not in_double and not in_backtick:
            in_single = not in_single
        elif char == '"' and not in_single and not in_backtick:
            in_double = not in_double
        elif char == "`" and not in_single and not in_double:
            in_backtick = not in_backtick
        elif not in_single and not in_double and not in_backtick:
            for marker in markers:
                if line.startswith(marker, i):
                    if shell_rules and marker == HASH and suffix in SHELL_LIKE:
                        previous = line[i - 1] if i else ""
                        if previous and previous not in " \t;&|(":
                            break
                        if i + 1 < len(line) and line[i + 1] in "#{":
                            break
                    return i
        i += 1
    return -1


def strip_text(source, suffix):
    markers = markers_for(suffix)
    block = BLOCK.get(suffix)
    out = []
    in_block = False
    scalar_indent = None
    for line in source.split("\n"):
        if scalar_indent is not None:
            if line.strip() == "" or (len(line) - len(line.lstrip())) > scalar_indent:
                out.append(line.rstrip())
                continue
            scalar_indent = None
        if suffix in (".yml", ".yaml"):
            match = BLOCK_SCALAR.match(line)
            if match:
                out.append(line.rstrip())
                scalar_indent = len(match.group(1))
                continue
        if in_block:
            if block and block[1] in line:
                rest = line.split(block[1], 1)[1]
                in_block = False
                if rest.strip():
                    out.append(rest.rstrip())
            continue
        block_at = marker_index(line, [block[0]], suffix, False) if block else -1
        if block_at >= 0:
            index = block_at
            head = line[:index]
            tail = line[index:]
            if block[1] in tail[len(block[0]):]:
                rest = tail.split(block[1], 1)[1]
                merged = (head + rest).rstrip()
                if merged.strip():
                    out.append(merged)
                continue
            in_block = True
            if head.strip():
                out.append(head.rstrip())
            continue
        if KEEP_LINE.match(line):
            out.append(line.rstrip())
            continue
        index = marker_index(line, markers, suffix) if markers else -1
        if index < 0:
            out.append(line.rstrip())
            continue
        head = line[:index].rstrip()
        if head:
            out.append(head)

    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text).lstrip("\n")
    if source.endswith("\n") and not text.endswith("\n"):
        text += "\n"
    return text


def verify(path, suffix, before, after):
    if suffix in (".yml", ".yaml"):
        try:
            if list(yaml.safe_load_all(before)) != list(yaml.safe_load_all(after)):
                return "parsed YAML differs"
        except Exception as error:
            return f"YAML no longer parses: {error}"
    if suffix in (".sh", ".bash"):
        result = subprocess.run(["bash", "-n", "-"], input=after, text=True, capture_output=True)
        if result.returncode:
            return f"bash -n rejects: {result.stderr.strip()[:120]}"
    if before.count("'") != after.count("'") and suffix not in (".sql", ".md"):
        pass
    return None


SELF_TEST = [
    (".hcl", 'path "transit/keys/*" {\n  capabilities = ["deny"]\n}\n'),
    (".hcl", 'path "a" {\n  capabilities = ["read"]\n}\n'),
    (".yml", 'services:\n  a:\n    command: >\n      run --flag=#notacomment\n      --more\n'),
    (".yml", 'services:\n  a:\n    command: ["sh", "-c", "echo \'#1\'"]\n'),
    (".sh", 'name="${path##*/}"\necho "$name"\n'),
    (".sh", 'count=$#\nurl="https://example.invalid/x"\n'),
    (".sql", "SELECT 'a--b' AS text_with_dashes;\n"),
    (".conf", 'listen = "0.0.0.0:80"\n'),
    (".tf", 'variable "a" {\n  default = "x/*y"\n}\n'),
]


def self_test():
    failures = []
    for suffix, source in SELF_TEST:
        result = strip_text(source, suffix)
        if result != source:
            failures.append((suffix, source, result))
    for suffix, source, result in failures:
        print(f"self-test changed a comment-free {suffix} file:")
        print(f"  before: {source!r}")
        print(f"  after:  {result!r}")
    print(f"self-test: {len(SELF_TEST) - len(failures)}/{len(SELF_TEST)} comment-free samples left untouched")
    return 1 if failures else 0


def tracked():
    output = subprocess.run(["git", "ls-files", "-z"], capture_output=True, text=True, check=True).stdout
    return [n for n in output.split("\0") if n and "node_modules/" not in n]


def main():
    if "--self-test" in sys.argv:
        return self_test()
    if self_test():
        print("::error::the comment stripper failed its own self-test")
        return 2
    fix = "--fix" in sys.argv
    names = [a for a in sys.argv[1:] if not a.startswith("-")] or tracked()
    changed = failed = offenders = scanned = 0
    for name in names:
        path = pathlib.Path(name)
        suffix = suffix_of(name)
        if not markers_for(suffix) and suffix not in BLOCK:
            continue
        try:
            source = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        scanned += 1
        result = strip_text(source, suffix)
        if result == source:
            continue
        problem = verify(path, suffix, source, result)
        if problem:
            print(f"::error file={name}::could not be stripped safely: {problem}")
            failed += 1
            continue
        if not fix:
            removed = source.count("\n") - result.count("\n")
            print(f"::error file={name}::carries comments ({removed} lines); this repository carries none")
            offenders += 1
            continue
        path.write_text(result, encoding="utf-8")
        removed = source.count("\n") - result.count("\n")
        print(f"  {name}  -{removed} lines")
        changed += 1

    if fix:
        print(f"{changed} file(s) rewritten, {failed} failed, {scanned} scanned")
        return 1 if failed else 0
    if offenders or failed:
        print(f"{offenders + failed} of {scanned} file(s) carry comments. "
              f"Run: python3 .github/scripts/check-comments.py --fix")
        return 1
    print(f"clean: {scanned} files carry no comments")
    return 0


if __name__ == "__main__":
    sys.exit(main())
