#!/usr/bin/env python3
import copy
import json
import pathlib
import posixpath
import re
import sys

import jsonschema
import yaml

SPEC_ROOTS = ["platform/gitops", "platform/policies"]
SCHEMA_ROOT = pathlib.Path("platform/gitops/schemas")
SKIP_PARTS = {"node_modules", ".git", "schemas"}

PATH_KINDS = [
    (re.compile(r"^platform/gitops/apps/[^/]+/app\.ya?ml$"), "ServiceFabricApp"),
    (re.compile(r"^platform/gitops/environments/[^/]+\.ya?ml$"), "Environment"),
    (re.compile(r"^platform/gitops/storage/buckets\.ya?ml$"), "BucketSet"),
    (re.compile(r"^platform/gitops/identity/gmsa\.ya?ml$"), "ServiceAccounts"),
    (re.compile(r"^platform/policies/firewall/[^/]+\.ya?ml$"), "IpsecRules"),
]

RULE_FILES = re.compile(r"^platform/gitops/apps/[^/]+/[^/]*alerts\.ya?ml$")

PLACEHOLDER = re.compile(r"^<[^>]*>$")
GROUP_PRINCIPAL = re.compile(r"^[A-Z][A-Z0-9-]*$")
ACCOUNT_PRINCIPAL = re.compile(r"^(?:gmsa-|svc-)")


def load_schemas():
    schemas = {}
    for path in sorted(SCHEMA_ROOT.glob("*.schema.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        kind = (document.get("properties", {}).get("kind", {}).get("const")
                or document.get("title") or path.stem.split(".")[0])
        schemas[kind] = (str(path), document)
    return schemas


def spec_files():
    for root in SPEC_ROOTS:
        for pattern in ("*.yaml", "*.yml"):
            for path in sorted(pathlib.Path(root).rglob(pattern)):
                if SKIP_PARTS & set(path.parts):
                    continue
                yield path


def load_tree():
    tree = {}
    unreadable = []
    for path in spec_files():
        name = path.as_posix()
        try:
            tree[name] = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception as error:
            unreadable.append((name, f"does not parse: {error}"))
    return tree, unreadable


def required_kind(name):
    for pattern, kind in PATH_KINDS:
        if pattern.match(name):
            return kind
    return None


def rule_file_problems(document):
    problems = []
    if not isinstance(document, dict) or set(document) != {"groups"}:
        return ["a Prometheus rule file must hold exactly one top-level key, groups"]
    groups = document["groups"]
    if not isinstance(groups, list) or not groups:
        return ["groups must be a non-empty list"]
    for g, group in enumerate(groups):
        if not isinstance(group, dict) or not isinstance(group.get("name"), str) or not group.get("name"):
            problems.append(f"groups[{g}] has no name")
            continue
        rules = group.get("rules")
        if not isinstance(rules, list) or not rules:
            problems.append(f"groups[{g}] ({group['name']}) has no rules")
            continue
        for r, rule in enumerate(rules):
            where = f"groups[{g}].rules[{r}]"
            if not isinstance(rule, dict):
                problems.append(f"{where} is not a mapping")
                continue
            named = [key for key in ("alert", "record") if key in rule]
            if len(named) != 1:
                problems.append(f"{where} must have exactly one of alert or record")
            elif not isinstance(rule[named[0]], str) or not rule[named[0]].strip():
                problems.append(f"{where} has an empty {named[0]}")
            if not isinstance(rule.get("expr"), (str, int, float)) or not str(rule.get("expr")).strip():
                problems.append(f"{where} has no expr")
    return problems


def as_list(value):
    return value if isinstance(value, list) else []


def as_dict(value):
    return value if isinstance(value, dict) else {}


def by_kind(typed, kind):
    return [(name, document) for name, (found, document) in typed.items() if found == kind]


def cross_file(typed, tree, strict):
    errors = []
    warnings = []

    buckets = set()
    for name, document in by_kind(typed, "BucketSet"):
        for bucket in as_list(document.get("buckets")):
            if not isinstance(bucket, dict):
                continue
            bucket_name = bucket.get("name")
            if not isinstance(bucket_name, str):
                continue
            if bucket_name in buckets:
                errors.append((name, f"bucket {bucket_name!r} is declared twice"))
            buckets.add(bucket_name)
            if "objectLock" in bucket and "versioning" not in bucket:
                message = (f"bucket {bucket_name!r} has objectLock but does not declare versioning: true; "
                           "object lock needs versioning, so say so")
                (errors if strict else warnings).append((name, message))

    accounts = set()
    for name, document in by_kind(typed, "ServiceAccounts"):
        for account in as_list(document.get("accounts")):
            if not isinstance(account, dict):
                continue
            account_name = account.get("name")
            if not isinstance(account_name, str):
                continue
            if account_name in accounts:
                errors.append((name, f"service account {account_name!r} is declared twice"))
            accounts.add(account_name)

    apps = {}
    for name, document in by_kind(typed, "ServiceFabricApp"):
        metadata = as_dict(document.get("metadata"))
        spec = as_dict(document.get("spec"))
        app = metadata.get("name")
        folder = name.split("/")[-2]
        if app != folder:
            errors.append((name, f"metadata.name {app!r} does not match its folder {folder!r}"))
        if isinstance(app, str):
            apps[app] = name

        services = [s for s in as_list(spec.get("services")) if isinstance(s, dict)]
        declared = {s.get("name") for s in services if isinstance(s.get("name"), str)}
        ingress = as_dict(spec.get("ingress"))
        if ingress and str(ingress.get("upstream")) not in declared:
            errors.append((name, f"ingress upstream {ingress.get('upstream')!r} names no service of this app"))
        probe = as_dict(as_dict(spec.get("health")).get("probe"))
        if probe and str(probe.get("upstream")) not in declared:
            errors.append((name, f"health probe upstream {probe.get('upstream')!r} names no service of this app"))

        ports = {}
        for service in services:
            for endpoint in as_list(service.get("endpoints")):
                if not isinstance(endpoint, dict):
                    continue
                port = endpoint.get("port")
                if not isinstance(port, int):
                    continue
                if port in ports:
                    errors.append((name, f"port {port} is used by both {ports[port]} and {service.get('name')}"))
                else:
                    ports[port] = service.get("name")

        bucket = as_dict(spec.get("package")).get("bucket")
        if isinstance(bucket, str) and bucket not in buckets:
            errors.append((name, f"package bucket {bucket!r} is not declared in a BucketSet"))

        identity = spec.get("identity")
        if isinstance(identity, str) and identity not in accounts:
            errors.append((name, f"identity {identity!r} is not declared in ServiceAccounts"))

        alerts = spec.get("alerts")
        if isinstance(alerts, str):
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), alerts))
            if target not in tree:
                errors.append((name, f"alerts file {alerts!r} does not exist next to this spec"))
            elif not RULE_FILES.match(target):
                errors.append((name, f"alerts file {alerts!r} is not named *alerts.yaml, so Prometheus will not load it"))

    for name, document in by_kind(typed, "Environment"):
        for app, pin in as_dict(document.get("apps")).items():
            if app not in apps:
                errors.append((name, f"app {app!r} is pinned here but has no spec at platform/gitops/apps/{app}/app.yaml"))
            digest = as_dict(pin).get("sha256")
            if isinstance(digest, str) and PLACEHOLDER.match(digest):
                message = f"app {app!r} is pinned to the placeholder digest {digest!r}, not a SHA-256"
                (errors if strict else warnings).append((name, message))

    for name, document in by_kind(typed, "IpsecRules"):
        for index, rule in enumerate(as_list(document.get("rules"))):
            if not isinstance(rule, dict):
                continue
            for principal in as_list(rule.get("from")):
                head = str(principal).split(":", 1)[0]
                if ACCOUNT_PRINCIPAL.match(head):
                    if head not in accounts:
                        errors.append((name, f"rules[{index}] principal {principal!r} does not resolve to a declared service account"))
                elif not GROUP_PRINCIPAL.match(head):
                    errors.append((name, f"rules[{index}] principal {principal!r} does not resolve: it is neither a "
                                         "declared service account nor an upper-case directory group"))

    return errors, warnings


def validate(tree, schemas, strict=False):
    errors = []
    typed = {}
    validated = 0
    for name in sorted(tree):
        document = tree[name]
        expected = required_kind(name)
        kind = document.get("kind") if isinstance(document, dict) else None
        if kind is not None and not isinstance(kind, str):
            errors.append((name, f"has a kind that is not a string: {kind!r}"))
            continue
        if RULE_FILES.match(name) and kind is None:
            for problem in rule_file_problems(document):
                errors.append((name, problem))
            continue
        if kind is None:
            errors.append((name, "carries no kind and is not a Prometheus rule file (apps/*/*alerts.yaml)"))
            continue
        if kind not in schemas:
            errors.append((name, f"has unknown kind {kind!r}; add a schema under {SCHEMA_ROOT.as_posix()}/"))
            continue
        if expected is None:
            errors.append((name, f"is kind {kind!r} in a path that no rule in check-gitops.py maps to a kind"))
            continue
        if kind != expected:
            errors.append((name, f"is kind {kind!r} but files at this path must be kind {expected!r}"))
            continue
        _, schema = schemas[kind]
        found = sorted(jsonschema.Draft202012Validator(schema).iter_errors(document), key=lambda e: [str(part) for part in e.path])
        for error in found:
            location = "/".join(str(part) for part in error.path) or "(root)"
            errors.append((name, f"{location}: {error.message}"))
        if not found:
            validated += 1
        typed[name] = (kind, document)
    more_errors, warnings = cross_file(typed, tree, strict)
    return errors + more_errors, warnings, validated


def self_test_tree():
    return {
        "platform/gitops/apps/shop/app.yaml": {
            "apiVersion": "argus/v1",
            "kind": "ServiceFabricApp",
            "metadata": {"name": "shop", "owner": "riley", "tier": 1},
            "spec": {
                "package": {"bucket": "argus-artifacts", "key": "shop/{{ version }}.sfpkg", "signature": "authenticode"},
                "identity": "gmsa-shop$",
                "services": [
                    {"name": "ShopApi", "type": "GuestExecutable", "exe": "Shop.Api.exe", "instances": 2,
                     "endpoints": [{"name": "http", "port": 5200}],
                     "env": {
                         "ASPNETCORE_URLS": "http://0.0.0.0:5200",
                         "SMTP_PASS": "{{ openbao:kv/shop/smtp#password }}",
                         "ConnectionStrings__Default": "Server=sql-01.example.com,1433;Database=shop;Integrated Security=true;",
                         "Cache__Redis": "cache.example.com:6379,ssl=true",
                     }},
                    {"name": "ShopWeb", "type": "GuestExecutable", "exe": "server.js", "instances": 2,
                     "endpoints": [{"name": "http", "port": 3200}]},
                ],
                "ingress": {"host": "shop.example.com", "upstream": "ShopWeb"},
                "health": {"probe": {"path": "/health", "upstream": "ShopApi", "intervalSeconds": 10}},
                "alerts": "alerts.yaml",
            },
        },
        "platform/gitops/apps/shop/alerts.yaml": {
            "groups": [{"name": "shop", "rules": [
                {"alert": "ShopDown", "expr": "up{app=\"shop\"} == 0", "for": "5m"},
                {"record": "shop:requests:rate5m", "expr": "sum(rate(http_requests_total{app=\"shop\"}[5m]))"},
            ]}],
        },
        "platform/gitops/environments/production.yaml": {
            "apiVersion": "argus/v1", "kind": "Environment", "name": "production",
            "apps": {"shop": {"version": "1.0.0", "sha256": "a" * 64}},
        },
        "platform/gitops/storage/buckets.yaml": {
            "apiVersion": "argus/v1", "kind": "BucketSet",
            "buckets": [
                {"name": "argus-artifacts", "owner": "gmsa-ci$", "versioning": True,
                 "objectLock": {"mode": "COMPLIANCE", "days": 30}},
                {"name": "argus-uploads", "owner": "gmsa-shop$"},
            ],
        },
        "platform/gitops/identity/gmsa.yaml": {
            "apiVersion": "argus/v1", "kind": "ServiceAccounts",
            "accounts": [
                {"name": "gmsa-shop$", "hosts": ["sf-*"], "tier": 1},
                {"name": "gmsa-ci$", "hosts": ["runner-01"], "tier": 1},
            ],
        },
        "platform/policies/firewall/ipsec-rules.yaml": {
            "apiVersion": "argus/v1", "kind": "IpsecRules", "default": "deny-all",
            "authentication": ["kerberos-machine"], "encryption": "aes256-gcm",
            "rules": [{"to": "sf-*", "port": 5200, "from": ["gmsa-shop$", "ADMIN-VPN:PAW", "gmsa-ci$:JEA"]}],
        },
    }


APP = "platform/gitops/apps/shop/app.yaml"
ENV = "platform/gitops/environments/production.yaml"
BUCKETS = "platform/gitops/storage/buckets.yaml"
RULES = "platform/gitops/apps/shop/alerts.yaml"
IPSEC = "platform/policies/firewall/ipsec-rules.yaml"


def env_of(tree):
    return tree[APP]["spec"]["services"][0]["env"]


SELF_TEST_MUTATIONS = [
    ("a spec with no kind", lambda t: t[APP].pop("kind"), APP, "carries no kind"),
    ("an unknown kind", lambda t: t[ENV].update(kind="Enviroment"), ENV, "unknown kind"),
    ("a kind in the wrong path", lambda t: t[ENV].update(kind="BucketSet"), ENV, "must be kind 'Environment'"),
    ("a known kind in an unmapped path",
     lambda t: t.update({"platform/gitops/network/extra.yaml": copy.deepcopy(t[ENV])}),
     "platform/gitops/network/extra.yaml", "no rule in check-gitops.py"),
    ("kind-less YAML that is not a rule file",
     lambda t: t.update({"platform/gitops/network/routes.yaml": {"routes": []}}),
     "platform/gitops/network/routes.yaml", "not a Prometheus rule file"),
    ("a rule with no expr", lambda t: t[RULES]["groups"][0]["rules"][0].pop("expr"), RULES, "has no expr"),
    ("a rule that is both alert and record",
     lambda t: t[RULES]["groups"][0]["rules"][0].update(record="x:y"), RULES, "exactly one of alert or record"),
    ("a rule file with no groups", lambda t: t.update({RULES: {"rules": []}}), RULES, "groups"),
    ("an ingress upstream that is no service",
     lambda t: t[APP]["spec"]["ingress"].update(upstream="ShopGateway"), APP, "ingress upstream"),
    ("a probe upstream that is no service",
     lambda t: t[APP]["spec"]["health"]["probe"].update(upstream="ShopWorker"), APP, "probe upstream"),
    ("two endpoints on one port",
     lambda t: t[APP]["spec"]["services"][1]["endpoints"][0].update(port=5200), APP, "port 5200"),
    ("a package bucket nobody declared",
     lambda t: t[APP]["spec"]["package"].update(bucket="argus-missing"), APP, "package bucket"),
    ("an identity nobody declared", lambda t: t[APP]["spec"].update(identity="gmsa-ghost$"), APP, "identity"),
    ("an alerts file that does not exist", lambda t: t.pop(RULES), APP, "does not exist"),
    ("an environment app with no spec",
     lambda t: t[ENV]["apps"].update(ghost={"version": "1.0.0", "sha256": "b" * 64}), ENV, "has no spec"),
    ("a folder that does not match metadata.name",
     lambda t: t[APP]["metadata"].update(name="store"), APP, "does not match its folder"),
    ("a bucket declared twice",
     lambda t: t[BUCKETS]["buckets"].append({"name": "argus-uploads", "owner": "gmsa-shop$"}), BUCKETS,
     "declared twice"),
    ("an IPsec account that does not resolve",
     lambda t: t[IPSEC]["rules"][0]["from"].append("gmsa-ghost$"), IPSEC, "does not resolve"),
    ("an IPsec principal of no known shape",
     lambda t: t[IPSEC]["rules"][0]["from"].append("grafana:sql-only"), IPSEC, "does not resolve"),
    ("an SA_PW literal", lambda t: env_of(t).update(SA_PW="hunter2-literal"), APP, "SA_PW"),
    ("an SMTP_PASS literal", lambda t: env_of(t).update(SMTP_PASS="hunter2-literal"), APP, "SMTP_PASS"),
    ("a PW_ prefixed literal", lambda t: env_of(t).update(PW_ADMIN="hunter2-literal"), APP, "PW_ADMIN"),
    ("a URL with an empty user and a password",
     lambda t: env_of(t).update(Cache__Redis="redis://:hunter2@cache.example.com:6379"), APP, "Cache__Redis"),
    ("a connection string with Pass=",
     lambda t: env_of(t).update(ConnectionStrings__Default="Server=sql-01;User Id=shop;Pass=hunter2;"), APP,
     "ConnectionStrings__Default"),
    ("object lock with versioning off",
     lambda t: t[BUCKETS]["buckets"][0].update(versioning=False), BUCKETS, "buckets/0"),
]


def self_test(schemas):
    failures = []
    errors, warnings, _ = validate(self_test_tree(), schemas)
    if errors or warnings:
        failures.append(f"the valid sample tree produced {errors + warnings}")
    for why, mutate, where, needle in SELF_TEST_MUTATIONS:
        tree = self_test_tree()
        mutate(tree)
        errors, _, _ = validate(tree, schemas)
        if not any(name == where and needle in message for name, message in errors):
            failures.append(f"did not reject {why} (wanted {needle!r} on {where}, got {errors})")

    tree = self_test_tree()
    tree[ENV]["apps"]["shop"]["sha256"] = "<filled by CI>"
    errors, warnings, _ = validate(tree, schemas)
    if errors or not any("placeholder digest" in message for _, message in warnings):
        failures.append("did not downgrade a placeholder digest to a warning")
    errors, warnings, _ = validate(tree, schemas, strict=True)
    if not any("placeholder digest" in message for _, message in errors):
        failures.append("did not reject a placeholder digest under --strict")

    tree = self_test_tree()
    tree[BUCKETS]["buckets"][0].pop("versioning")
    errors, warnings, _ = validate(tree, schemas)
    if errors or not any("versioning" in message for _, message in warnings):
        failures.append("did not warn about object lock without declared versioning")

    for failure in failures:
        print(f"self-test: {failure}")
    total = 1 + len(SELF_TEST_MUTATIONS) + 3
    print(f"self-test: {total - len(failures)}/{total} GitOps samples judged correctly")
    return 1 if failures else 0


def main():
    strict = "--strict" in sys.argv
    schemas = load_schemas()
    for kind, (path, document) in schemas.items():
        try:
            jsonschema.Draft202012Validator.check_schema(document)
        except jsonschema.SchemaError as error:
            print(f"::error file={path}::is not a valid JSON Schema 2020-12 document: {error.message}")
            return 1
    missing = sorted({kind for _, kind in PATH_KINDS} - set(schemas))
    if missing:
        print(f"::error::no schema under {SCHEMA_ROOT.as_posix()} for {', '.join(missing)}")
        return 1

    if "--self-test" in sys.argv:
        return self_test(schemas)
    if self_test(schemas):
        print("::error::the GitOps checker failed its own self-test")
        return 2

    tree, unreadable = load_tree()
    errors, warnings, validated = validate(tree, schemas, strict)
    errors = unreadable + errors
    for name, message in warnings:
        print(f"::warning file={name}::{message}")
    for name, message in errors:
        print(f"::error file={name}::{message}")
    print(f"{validated} spec(s) validated against {len(schemas)} schema(s) and cross-checked, "
          f"{len(tree)} file(s) read, {len(errors)} error(s), {len(warnings)} warning(s)"
          f"{' (strict)' if strict else ''}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
