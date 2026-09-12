#!/usr/bin/env python3
import math
import pathlib
import re
import subprocess
import sys

HARD_RULES = [
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("github-fine-grained-token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{60,}\b")),
    ("anthropic-key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{24,}\b")),
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9]{32,}\b")),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("stripe-key", re.compile(r"\b[rs]k_live_[A-Za-z0-9]{20,}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("npm-token", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    ("private-key-block", re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----")),
    ("json-web-token", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
]

SECRET_KEY = re.compile(
    r"(?:^|[^A-Za-z0-9_])"
    r"(?P<key>[A-Za-z0-9_.\[\]'\"$-]*?"
    r"(?:password|passwd|pwd|secret|token|apikey|api[_-]key|accesskey|access[_-]key|"
    r"secret[_-]key|private[_-]key|credential|auth)s?)"
    r"['\"\]]*\s*(?::=|=>|[:=])\s*"
    r"(?P<value>.+)$",
    re.IGNORECASE,
)

SLUG = re.compile(r"^[A-Za-z]{2,}(?:[-_][A-Za-z0-9]{1,}){1,5}$")

PLACEHOLDER = re.compile(
    r"^(?:changeme|change[_-]me|replace[_-]?me.*|xxx+|yyy+|zzz+|todo|fixme|none|null|nil|true|false|"
    r"example|placeholder|redacted|dummy|sample|test|unset|empty|generated|auto|random|"
    r"your[_-].*|my[_-].*|the[_-].*|a[_-].*|[.]{3}|[*]+|-+|"
    r"password|passwd|secret|token|apikey|api_key|key|value|string|hash|salt)$",
    re.IGNORECASE,
)

EXPRESSION_START = tuple("$%{<`([&@!|")

CALL = re.compile(r"^[A-Za-z_][A-Za-z0-9_.:-]*\s*\(")
CMDLET = re.compile(r"^[A-Z][a-zA-Z]+-[A-Z][a-zA-Z0-9]*")
ENV_LOOKUP = re.compile(
    r"process\.env|os\.environ|getenv|System\.getenv|Environment\.Get|ENV\[|\$env:|viper\.|config\.|settings\.",
    re.IGNORECASE,
)
REFERENCE = re.compile(r"\{\{.*\}\}|\$\{.*\}|%[A-Za-z_]+%|<[A-Za-z_][^>]*>")
IDENTIFIER_ONLY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
DOTTED_PATH = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)+$")
HEX_OR_B64 = re.compile(r"^[A-Za-z0-9+/=_-]+$")

LINE_COMMENT = {
    ".py": ["#"], ".sh": ["#"], ".bash": ["#"], ".yml": ["#"], ".yaml": ["#"],
    ".conf": ["#"], ".hcl": ["#", "//"], ".toml": ["#"], ".ps1": ["#"], ".psm1": ["#"],
    ".psd1": ["#"], ".env": ["#"], ".example": ["#"], ".gitignore": ["#"], ".gitattributes": ["#"],
    ".js": ["//"], ".mjs": ["//"], ".cjs": ["//"], ".ts": ["//"], ".css": [], ".go": ["//"],
    ".cs": ["//"], ".java": ["//"], ".rs": ["//"], ".tf": ["#", "//"], ".sql": ["--"],
    ".md": [], ".json": [], ".html": [],
}

BINARY_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2",
    ".pdf", ".zip", ".gz", ".tar", ".exe", ".dll", ".pfx", ".p12",
}

MIN_VALUE_LENGTH = 12
MIN_ENTROPY = 3.0


def suffix_of(path):
    dot = path.rfind(".")
    slash = max(path.rfind("/"), path.rfind("\\"))
    if dot <= slash:
        base = path[slash + 1:]
        return "Dockerfile" if base.startswith("Dockerfile") else ""
    return path[dot:].lower()


def comment_markers(path):
    suffix = suffix_of(path)
    if suffix == "Dockerfile":
        return ["#"]
    return LINE_COMMENT.get(suffix, ["#", "//"])


def comment_start(line, markers):
    in_single = False
    in_double = False
    index = 0
    while index < len(line):
        char = line[index]
        if char == "\\":
            index += 2
            continue
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        elif not in_single and not in_double:
            for marker in markers:
                if line.startswith(marker, index):
                    if marker == "#" and index + 1 < len(line) and line[index + 1] == "!" and index == 0:
                        break
                    return index
        index += 1
    return -1


def shannon(value):
    if not value:
        return 0.0
    total = 0.0
    for symbol in set(value):
        ratio = value.count(symbol) / len(value)
        total -= ratio * math.log2(ratio)
    return total


def unquote(value):
    value = value.strip()
    for quote in ('"', "'", "`"):
        if len(value) >= 2 and value.startswith(quote) and value.endswith(quote):
            return value[1:-1], True
    return value, False


def looks_like_secret(raw_value, in_query=False):
    value = raw_value.strip()
    if in_query:
        value = value.split("&")[0].split('"')[0].split("'")[0]
    if not value:
        return False
    if value[0] in EXPRESSION_START:
        return False
    if REFERENCE.search(value):
        return False
    if ENV_LOOKUP.search(value):
        return False
    value = value.strip().rstrip(";,")
    value, quoted = unquote(value)
    value = value.strip().rstrip(";,")
    if not value:
        return False
    if value[0] in EXPRESSION_START:
        return False
    if REFERENCE.search(value) or ENV_LOOKUP.search(value):
        return False
    if CALL.match(value) or CMDLET.match(value):
        return False
    if not quoted and " " in value:
        return False
    if PLACEHOLDER.match(value):
        return False
    if len(value) < MIN_VALUE_LENGTH:
        return False
    if IDENTIFIER_ONLY.match(value) and not HEX_OR_B64.match(value):
        return False
    if DOTTED_PATH.match(value):
        return False
    if SLUG.match(value):
        return False
    if value.startswith(("http://", "https://", "/", "./", "../")):
        return False
    if shannon(value) < MIN_ENTROPY:
        return False
    return True


def scan_line(path, number, line):
    findings = []
    for name, pattern in HARD_RULES:
        match = pattern.search(line)
        if match:
            findings.append((path, number, name, match.group(0)[:12] + "..."))
    markers = comment_markers(path)
    boundary = comment_start(line, markers) if markers else -1
    code = line[:boundary] if boundary >= 0 else line
    match = SECRET_KEY.search(code)
    in_query = bool(match) and match.start("key") > 0 and code[match.start("key") - 1] in "?&"
    if match and looks_like_secret(match.group("value"), in_query):
        findings.append((path, number, "hardcoded-credential", match.group("key")))
    return findings


SELF = "/".join(pathlib.Path(__file__).parts[-3:])


def tracked_files():
    output = subprocess.run(
        ["git", "ls-files", "-z"], capture_output=True, text=True, check=True
    ).stdout
    return [name for name in output.split("\0") if name and not name.endswith(SELF)]


def scan(paths):
    findings = []
    for path in paths:
        if suffix_of(path) in BINARY_SUFFIXES:
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="strict") as handle:
                for number, line in enumerate(handle, 1):
                    findings.extend(scan_line(path, number, line.rstrip("\n")))
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
    return findings


SELF_TEST_FLAG = [
    ("a.yml", '      # config.alloy redacts CNIC-shaped strings and password=/token= pairs at'),
    ("a.ps1", "$breakglassPassword = New-HexSecret 16"),
    ("a.ps1", "$gen['AZURITE_ACCOUNT_KEY']  = New-Base64Secret 32"),
    ("a.yml", "      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password"),
    ("a.yml", "      GF_SECURITY_ADMIN_PASSWORD__FILE: /run/secrets/grafana_admin"),
    ("a.js", "const password = process.env.ARGUS_PASSWORD;"),
    ("a.env", "ARGUS_S3_CONSOLE_SECRET="),
    ("a.yaml", "  password: {{ openbao:kv/data/argus/pg#password }}"),
    ("a.sh", 'password="$1"'),
    ("a.js", "// password = 'notarealsecretvalue123'"),
    ("a.md", "Set `password` to the value printed by bootstrap."),
    ("a.tf", 'password = var.db_password'),
    ("a.sql", "-- password = 'abcdefghijklmnop'"),
    ("a.conf", "requirepass ${GARNET_PASSWORD}"),
    ("a.js", "const tokenPattern = /^[a-f0-9]{32}$/;"),
    ("a.env", "GUAC_JSON_SECRET_KEY=replace-me-32-hex-chars"),
    ("a.yml", "      - password_encryption=scram-sha-256"),
    ("a.yml", "      AWS_ACCESS_KEY_ID: argus-console"),
    ("a.yml", "      ARGUS_PARITY_ACCESS_KEY: argus-parity"),
    ("a.js", "      credentials: 'same-origin',"),
    ("a.js", "process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/argus-smoke';"),
    ("a.yml", "      GF_DATABASE_PASSWORD_FILE: /run/secrets/grafana_db"),
    ("a.hcl", 'token_policies = ["argus-console"]'),
    ("a.js", "getJson('/connz?auth=true&limit=64')"),
    ("a.js", "fetch(base + '/jsz?consumers=true&config=true')"),
]

SELF_TEST_CATCH = [
    ("a.js", 'const password = "Tr0ub4dor&3xKcd-Horse";'),
    ("a.yml", "  password: 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c"),
    ("a.env", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI0K7MDENGbPxRfiCYEXAMPLEKEY"),
    ("a.cs", 'ConnectionString = "Server=x;Password=hV8x2Qm4Lp9Zt1Nw;"'),
    ("a.txt", "AKIAIOSFODNN7EXAMPLE"),
    ("a.txt", "ghp_1234567890abcdefghijklmnopqrstuvwxyz"),
    ("a.txt", "-----BEGIN RSA PRIVATE KEY-----"),
    ("a.js", "// sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ("a.yml", "      GUAC_JSON_SECRET_KEY: 4f3c8a1d9b2e7c5a6d0f8b3e1a9c7d52"),
    ("a.env", "ARGUS_S3_CONSOLE_SECRET=xK7pQ2mN9vL4wR8tY1uI3oP6aS5dF0gH"),
    ("a.js", "fetch('/api?auth=Xk92LmQp47vBnT5r&limit=2')"),
]


def self_test():
    failures = []
    for path, line in SELF_TEST_FLAG:
        hits = scan_line(path, 1, line)
        if hits:
            failures.append(("false positive", path, line, hits[0][2]))
    for path, line in SELF_TEST_CATCH:
        if not scan_line(path, 1, line):
            failures.append(("missed", path, line, ""))
    for kind, path, line, rule in failures:
        print(f"self-test {kind}: [{path}] {line}  {rule}")
    total = len(SELF_TEST_FLAG) + len(SELF_TEST_CATCH)
    print(f"self-test: {total - len(failures)}/{total} cases correct")
    return 1 if failures else 0


def main():
    if "--self-test" in sys.argv:
        return self_test()
    if self_test():
        print("::error::the secret scanner failed its own self-test")
        return 2
    paths = [a for a in sys.argv[1:] if not a.startswith("-")] or tracked_files()
    findings = scan(paths)
    for path, number, rule, detail in findings:
        print(f"::error file={path},line={number}::{rule}: {detail}")
    if findings:
        print(f"{len(findings)} credential-shaped string(s) present. Remove each and rotate the credential.")
        return 1
    print(f"clean: {len(paths)} tracked files scanned, no credentials found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
