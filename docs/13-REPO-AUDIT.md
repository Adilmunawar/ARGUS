# Repository audit — 2026-09-11

Scope: the whole tree at `main` (9b65193), the GitHub Actions history, and a
verified run of the console harnesses against real Chromium. Every finding
below was checked against file contents or a live run; line numbers refer to
the audited commit.

---

## 1. CI is red on `main`, and has been since 2026-09-09

Runs 8, 9 and 10 of `validate` all failed. Both jobs fail, for independent
reasons, and branch protection requires both checks — so every PR into `main`
is currently blocked.

### 1.1 Secret scan: two false positives fail the GitOps job

The grep in `.github/workflows/validate.yml:52` matches
`[Pp]assword\s*=\s*...` anywhere, and trips on:

- `platform/compose/docker-compose.yml:935` — a **comment**: "config.alloy
  redacts CNIC-shaped strings and password=/token= pairs at WRITE time".
- `platform/compose/bootstrap.ps1:261` — a **variable name**:
  `$breakglassPassword = New-HexSecret 16` (the value is generated, never
  literal).

Neither is a credential. The scan needs an allowlist mechanism (e.g. a
`# secret-scan: ignore` pragma, or excluding comment lines), not deletion of
the matched lines.

### 1.2 Sandbox: stale screen count fails the console job

`platform/console/prototype/tests/sandbox.js:137` asserts
`boot.screens === 10`; the console now registers **13** screens (`stack`,
`system`, `storage` were added since). All nine ENV environments fail on this
one assertion (113/122, exit code 9). Verified locally: these nine are the
*only* sandbox failures.

### 1.3 Knock-on: the stress suite has not run in CI since run 9

The sandbox step fails before the stress step, so the performance budgets
have not been enforced on any commit since, and the
`console-stress-report` artifact silently uploads nothing
(`if-no-files-found: ignore`).

---

## 2. GitHub Actions workflow hygiene (`validate.yml`)

- **No `permissions:` block.** The default `GITHUB_TOKEN` grant applies;
  should be `permissions: contents: read` at workflow level.
- **No `concurrency` group.** Rapid pushes queue redundant full Playwright
  runs.
- **Actions pinned to major tags, not SHAs** (`actions/checkout@v4` etc.) —
  weaker supply-chain posture than the rest of the repo's stance implies.
  The runner also warns these versions target deprecated Node 20; bump to
  the current majors.
- **grep failure modes read as "clean".** The `if grep ...; then fail` shape
  treats grep exit 2 (an error, e.g. unreadable file) the same as "no match",
  i.e. success.
- **CI never runs on non-`main` branch pushes** (`on.push.branches: [main]`
  plus `pull_request`) — a branch like this audit branch gets no signal until
  a PR is opened. Intentional-looking, but worth stating.
- **`--exclude='validate.yml'` matches by basename** — any other file named
  `validate.yml` anywhere in the tree is also skipped by the secret scan.

`publish.sh` (which configures the required checks) has its own defect:
the branch-protection call (`publish.sh:101-110`) sends every field with
`-f` (string), so `strict` becomes `"true"`, the review count `"1"`, and
`restrictions` an empty string where the API wants `null` — GitHub returns
422, the error is swallowed by `2>/dev/null`, and the script misreports it
as "needs a paid plan". Public repos can silently end up unprotected.

---

## 3. Test-harness integrity

The three newest screens are invisible to all three harnesses, and several
assertions cannot fail:

- `tests/sandbox.js:39` and `tests/run-tests.js:43` — **stale 10-route
  `ROUTES` lists** (no `stack`, `system`, `storage`). The click-sweep,
  accessibility, contrast, responsive and leak passes never visit the three
  screens that do live network fetches. `tests/stress.js:52,61-69,197` has
  the same staleness (`screens.length >= 10` floor included).
- `tests/run-tests.js:477` — collapsed-rail check asserts `>= 10` names while
  the nav has 12 buttons; two could lose accessible names undetected.
- `tests/sandbox.js:557` — FUZZ "tampered preference shapes were survived"
  passes the literal `true`; it can never fail.
- `tests/stress.js:402,513,557,802` — "skipped" outcomes recorded as
  `pass: true`; if the control disappears from the product the check goes
  green forever.
- `tests/sandbox.js:596-619` and `run-tests.js:1424-1437` — interval-leak
  accounting decrements on every `clearInterval` (double-clears go negative)
  and thresholds allow `net <= 1`, so one leaked interval per tour passes.
  The "exactly one live region" check actually allows two.
- `tests/run-tests.js:326` — STATE regex alternation is satisfied by the word
  "matches" anywhere, and its evidence field is `txt.slice(0, 0)` — always
  empty.
- Committed `tests/last-run.json` is all-green and current for the property
  suite, but it is the only committed test evidence while CI is actually red
  (the failing report, `sandbox-last-run.json`, is gitignored).

---

## 4. Security

- **`platform/console/server` has no authentication on any endpoint, and the
  container binds 0.0.0.0.** `config.js` claims loopback-by-default as the
  safety story, but `server/Dockerfile:43` sets `ENV ARGUS_HOST=0.0.0.0`, so
  in every containerized deployment any caller with network reach to 8787
  gets bucket browsing and object previews, live SQL text from
  `pg_stat_activity`, vault seal state, and host NIC/MAC/IP inventory. The
  JWT/role machinery exists only in the unrelated `Argus.Console.Api`
  skeleton (whose five authorization policies protect zero mapped routes).
- **`docker-compose.yml:1015`** — `GF_DATABASE_PASSWORD` is a plain env var,
  readable through the docker-socket-proxy — the exact channel the adjacent
  `__FILE`-based admin password (line 994) was written to defeat.
- **`gitops/schemas/app.schema.json:19`** — the env-secret guard uses the
  inline `(?i)` flag, invalid in the ECMA-262 dialect JSON Schema 2020-12
  specifies (works only because CI validates with Python `re`); and it
  inspects env *values* only, so a literal secret under a secret-named key
  passes.
- **`server/src/index.js:256,314`** — request pathname is percent-decoded and
  then logged verbatim: `%0a` forges log lines in the file operators are told
  to trust for 5xx diagnosis.
- **`.env.example:82`** — describes the console S3 credential as "no Write
  anywhere" while compose grants it Write on all eight buckets; a comment
  that misstates the posture of a credential.
- **`server/src/cache.js:19,52-61` + `pg.js:397`** — the TTL cache never
  evicts, and cache keys include user-supplied arguments
  (`?database=<anything>`), an unauthenticated unbounded-memory vector given
  the missing auth above.

---

## 5. Advertised features that cannot work (missing files)

Docker Compose bind-mounts sources that do not exist in the repo; Docker
creates empty directories in their place and the services crash-loop or start
unconfigured:

- `docker-compose.yml:879` — `./secrets/alertmanager.yml` is never rendered
  (no template exists, bootstrap has no render step) → Alertmanager
  crash-loops on the `observability` profile bootstrap explicitly advertises.
- `docker-compose.yml:841,905,938,1020` — `./services/observability/**`
  (Prometheus, Loki, Alloy, Grafana provisioning) does not exist.
- `docker-compose.yml:1283-1284` — `./services/connect/sql` missing →
  guac-init never completes → the whole `connect` profile (guacamole, guacd)
  never starts.
- `docker-compose.yml:1363,1480,1524` — `./services/compute/nomad.d` and
  `./services/parity` missing (parity's `node src/runner.js` has no source).
- `docker-compose.yml:675` — `../gitops/identity/openbao-policies` missing →
  no policy applied, console AppRole never issued on the `secrets` profile.
- `docker-compose.yml:1529-1530` — nothing creates the `pg/` subdirectory on
  the parity results volume → redirection fails every cycle, healthcheck
  permanently red.
- `platform/cli/Argus/Argus.psm1:9` — `Connect-Argus` calls
  `Get-ArgusDeviceCodeToken`, defined nowhere in the repo: the entire CLI
  module is dead. It also uses `??` with `PowerShellVersion 7.4` while the
  platform's own docs target PowerShell 5.1.
- `platform/iac/tofu/vm-sql-01.tf:3` — module `./modules/shielded-vm` does
  not exist; `tofu init` fails.
- The comment at `docker-compose.yml:518-534` is inverted: it says the
  cache/queues/secrets configs "are not committed yet" (they are) and omits
  the profiles whose sources genuinely are missing.

---

## 6. Correctness bugs

Console server (`platform/console/server/src`):

- `index.js:168` — `/api/pg/tables?database=X` passes a string where
  `pg.tables` expects an options object: the parameter is silently ignored,
  always listing `postgres`, and the wrong result is cached under a
  per-database key.
- `index.js:180` / `queues.js:879` — `/api/queues/consumers?stream=X`:
  `consumers` takes no arguments; the filter is silently ignored.
- `storage.js:46`, `pg.js:78`, `queues.js:71` — a malformed
  `ARGUS_UPSTREAM_TIMEOUT_MS` becomes `NaN` and silently disables every
  timeout in those modules (garnet.js/secrets.js validate; these don't).
- `storage.js:701-724` — any transient `HeadObject` failure is treated as
  "key does not exist" and the per-bucket verdict is cached forever, flipping
  healthy buckets into the expensive repair path until restart.
- `storage.js:962-970` — preview has a HEAD-then-GET race (cap and
  `content-length` from one request, body from another), and
  `undefined > N` makes the 5 MB cap a no-op when `ContentLength` is absent.
- `aws.js:217-235` — `alarms()` reads only the first page (100), silently
  undercounting `inAlarm` — contradicting the file's own pagination rationale
  at lines 135-137.
- `aws.js:249-251` — `cost()` builds a new CostExplorerClient per call and
  never destroys it.
- `config.js:16-21` — `int()` accepts 0 and negatives: `ARGUS_AWS_TIMEOUT_MS=0`
  aborts every AWS call, `ARGUS_CACHE_TTL_MS=-1` disables caching, silently.
- `test/smoke.js:200-208` — `warm <= cold + 50` is a wall-clock race; one GC
  pause fails the suite.

Object-storage init (`platform/console/tools/init-object-storage.js`):

- `:262-286` — on an existing bucket, declared retention is never re-applied
  and retention *days* are never compared (only `mode`), contradicting the
  header's "verifies and exits non-zero on mismatch". A 1-day retention
  against a declared 35-day COMPLIANCE lock passes green.
- `:76-84` — no request/connection timeout on the S3 client; one wedged
  socket after readiness hangs the init container and blocks console startup
  (gated on `service_completed_successfully`).
- `:127-130` — the credential-rejection error interpolates the live
  `AWS_ACCESS_KEY_ID` into container logs.

Bootstrap / teardown:

- `bootstrap.ps1:411` — the final `docker compose config -q` runs in the
  caller's cwd (bootstrap never does `Set-Location` like down.ps1 does), so
  running it from the repo root fails on a valid file.
- `down.ps1:45-51` — the "every profile" list omits `cache`, `queues`,
  `secrets`; those services are only removed via the `--remove-orphans`
  fallback, bypassing stop ordering and grace periods.
- `down.ps1:126-131` — `-RemoveImages` without `-DeleteData` is silently
  ignored.
- `bootstrap.ps1:191-199` — the port-collision check tests hardcoded defaults
  and never reads `*_PORT` overrides from an existing `.env`.
- `docker-compose.yml:1226` — `PROXY_ALLOWED_IPS_REGEX` hardcodes `172.28.`
  while `ARGUS_SUBNET` is overridable: following the file's own VPN-clash
  advice silently breaks RemoteIpValve, causing exactly the audit-IP failure
  the adjacent comment says this prevents.

Console prototype:

- The `storage` screen is registered but **orphaned**: no sidebar button and
  no link anywhere — reachable only via the command palette or a hand-typed
  URL (`index.html:46-100`, `screens/storage.js`).
- `app.js:927` — `GO_KEYS` and the shortcuts dialog omit `stack`, `system`
  and `storage`; two shipping nav sections have no `g`-key jump and are
  undocumented in the shortcuts dialog.
- `index.html:58,83,128` — deploy/alert badges and the bell `aria-label` are
  hardcoded ("1", "4"); nothing recomputes them from data.
- `screens/security.js:506,632` — the session player's 1 s interval is not
  registered with `A.onLeave`; it survives navigation by one tick only
  because of an in-tick detach check.

---

## 7. GitOps / docs drift

- `gitops/storage/buckets.yaml` — the three parity buckets are absent, yet
  compose mints S3 identities scoped to them and storage-init treats
  buckets.yaml as the single source: the parity harness has no buckets.
- `gitops/identity/gmsa.yaml` — announces "every service identity" but
  `gmsa-loki$`, `gmsa-geo$`, `gmsa-agis$` (bucket owner/readers and IPsec
  principals referenced elsewhere) are not defined.
- `gitops/environments/production.yaml:6` — pins apps `loan` and `caddy`
  which have no spec under `gitops/apps/`.
- `gitops/README.md:5` — "every file validates against `schemas/`" is untrue:
  only `apps/*/app.yaml` has a schema and only those are validated in CI.
- `policies/README.md` — lists WDAC/firewall/Sysmon/Wazuh artifacts, none of
  which exist; the only real policy file is `firewall/ipsec-rules.yaml`.
- `.env.example:120` — `SMTP_HOST=mailpit:1025` references a service that
  exists nowhere in compose.
- `.env.example:3-6` — claims `./secrets/` is not gitignored; it is.
- `docker-compose.yml:473-474` / `garnet.conf:171-173` — both claim bootstrap
  generates the two Garnet memory values from one source; bootstrap touches
  neither.
- `prototype/README.md:34` — "Ten sections" is stale (13 screens, 12 nav
  sections).
- `Argus.psm1:8` — claims DPAPI token caching; the token lives only in
  process memory.
- `publish.sh:81` — hardcodes `main` as the branch to push.

---

## What checked out clean

- `run-tests.js` property suite: 247/247 pass against real Chromium.
- No XSS surface in the prototype (no `innerHTML` anywhere; CSP verified);
  localStorage handling guarded and allowlist-validated; router hardened.
- `sql/*.sql`: idempotent, grants/roles internally consistent.
- Garnet/NATS/OpenBao init scripts: no shell-quoting, `set -e` or
  secrets-in-argv defects; RESP parser and pg pool handling in the server are
  sound.
- `.gitattributes` line-ending policy is coherent.

## Suggested order of attack

1. Unblock CI: fix the two secret-scan false positives (allowlist, don't
   delete), update `sandbox.js:137` to the real screen count, and refresh the
   `ROUTES`/`VIEWS` lists in all three harnesses so the new screens are
   actually tested.
2. Decide the console server's auth story (or at least drop
   `ARGUS_HOST=0.0.0.0` from the Dockerfile and document the reverse-proxy
   requirement).
3. Either commit the missing `services/observability`, `connect`, `compute`,
   `parity` and `openbao-policies` sources, or gate those profiles/comments
   honestly until they exist.
4. Fix the silent-parameter bugs (`pg/tables`, `queues/consumers`), the NaN
   timeout parsing, and the init tool's retention verification.
5. Sweep the docs/config drift in §7.
