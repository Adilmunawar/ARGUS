# Argus console API

The console API is a small Node.js HTTP server with no framework. It serves the console page from `../prototype`, and it answers `/api/*` with read-only views of the platform: host telemetry, the object store, PostgreSQL, Garnet, NATS, OpenBao, Loki, Prometheus, Alertmanager, the Docker socket proxy, the GitOps declarations, the runbooks and, while the migration lasts, the AWS account. It writes nothing upstream. Every reader degrades to `{ ok: false, reason, message }` when its upstream is absent, so a missing service shows up as an empty panel with an explanation rather than as a 500.

## Run it locally without Docker

Node 22 or later.

```sh
cd platform/console/server
npm ci
printf '%s\n' 'a long password for local use' | npm run --silent hash-operator-password > hash.txt
```

Write an operator file, for example `operators.local.json` (keep it out of the repository):

```json
{
  "operators": [
    { "subject": "operator-a", "displayName": "Operator A", "roles": ["admin"], "password": "<the line in hash.txt>" }
  ]
}
```

Then start the server against it:

```sh
ARGUS_AUTH_OPERATORS_FILE=./operators.local.json npm start
```

It listens on `http://127.0.0.1:8787`. Sign in through the page, or with `POST /api/auth/login` and a JSON body `{ "subject": "operator-a", "password": "..." }` (send `Content-Type: application/json` and `X-Argus-Console: 1`).

`ARGUS_AUTH=off` skips sign-in and answers every route as a local administrator. It is accepted only on a loopback bind, and only for loopback host names.

Tests: `npm test` runs every suite (`test/run-all.js`) and reports each one even when an earlier one fails. `npm run test:smoke`, `test:auth`, `test:streams`, `test:storage`, `test:sources` and `test:units` run one suite. No suite needs Docker or the network; every server and stub listens on a port the operating system assigns.

## Request pipeline

Every request passes these gates in order. The first one that refuses answers.

1. **Host.** The `Host` header must name a loopback address (`127.0.0.1`, `localhost`, `[::1]`) with the port the server is bound to, the host of `ARGUS_AUTH_PUBLIC_ORIGIN`, or an entry of `ARGUS_ALLOWED_HOSTS`. Anything else is `421 misdirected`. This stops DNS rebinding. With `ARGUS_AUTH=off` only loopback names are answered.
2. **Origin.** Browser fetch metadata and `Origin` must say the request came from the console itself (`403 cross-site`). State-changing requests also need `Content-Type: application/json` and `X-Argus-Console: 1`.
3. **Sign-in and sign-out** (`POST /api/auth/login`, `POST /api/auth/logout`).
4. **Session.** A request carrying two session cookies is `401 duplicate-session-cookie`, and both are cleared.
5. **Metrics token** for `/metrics` (see below).
6. **Authentication.** Every `/api/*` route except `/api/health` and `/api/capabilities` needs a principal (`401 unauthenticated`).
7. **Role.** The route must be open to the principal's tier (`403 forbidden`, reason `role`).
8. **Read-only.** Anything but GET and HEAD is `405 read-only` unless `ARGUS_ALLOW_WRITES=1`. HEAD on a stream route is `405 method-not-allowed`.

## Roles

Roles are tiers. Each tier can read everything the tiers below it can.

| Tier | Grants |
|---|---|
| `viewer` | health, capabilities, host, GitOps, runbooks, heartbeats, storage buckets and capacity, metric series |
| `operator` | viewer, plus logs, containers, PostgreSQL activity, statements and the other PostgreSQL readers, storage objects and previews, queues, cache, secrets status, alerts, search, the other Prometheus readers |
| `security` | operator, plus `/api/audit/recent`, `/api/identity/principals` and `/api/pg/roles` |
| `admin` | everything, including the AWS routes and `/api/overview` |

A principal's tier is the highest tier named in its roles (case-insensitive). Any other role name, such as `tier-1`, grants nothing on its own. An operator record with no roles, or with no recognised role, is a `viewer`. Under `ARGUS_AUTH=proxy` the roles are the groups the proxy sends; under `ARGUS_AUTH=off` the principal is `admin`. Any `/api/*` path that is not in the map below is `admin` only, so a new route is closed until someone gives it a tier. `GET /api/auth/session` and authenticated `GET /api/capabilities` report the tier as `tier`.

## Routes

| Route | Tier |
|---|---|
| `GET /api/health` | public (adds `version` when signed in) |
| `GET /api/capabilities` | public (reduced shape when anonymous) |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session` | public |
| `GET /api/host` | viewer |
| `GET /api/gitops/apps`, `/api/gitops/environments`, `/api/gitops/service-accounts` | viewer |
| `GET /api/runbooks`, `/api/runbooks/body?path=` | viewer |
| `GET /api/heartbeats?slots=`, `/api/heartbeats/uptime`, `/api/heartbeats/incidents?limit=` | viewer |
| `GET /api/heartbeats/stream` (SSE) | viewer |
| `GET /api/storage/buckets`, `/api/storage/capacity` | viewer |
| `GET /api/metrics/series?name=&window=&points=` | viewer |
| `GET /api/storage/health`, `/api/storage/lock-status` | operator |
| `GET /api/storage/objects?bucket=&prefix=&cursor=`, `/api/storage/object?bucket=&key=`, `/api/storage/prefix-size?bucket=&prefix=`, `/api/storage/preview?bucket=&key=` | operator |
| `GET /api/pg/server`, `/api/pg/databases`, `/api/pg/activity`, `/api/pg/statements`, `/api/pg/replication`, `/api/pg/tables?database=`, `/api/pg/health` | operator |
| `GET /api/cache/server`, `/api/cache/memory`, `/api/cache/clients`, `/api/cache/keyspace`, `/api/cache/health` | operator |
| `GET /api/queues/server`, `/api/queues/account`, `/api/queues/streams`, `/api/queues/consumers?stream=`, `/api/queues/health` | operator |
| `GET /api/secrets/health`, `/api/secrets/seal-status`, `/api/secrets/ha`, `/api/secrets/sandbox` | operator |
| `GET /api/logs/health`, `/api/logs/labels`, `/api/logs/label-values?name=`, `/api/logs/query`, `/api/logs/volume`, `/api/logs/patterns` | operator |
| `GET /api/logs/stream?query=&limit=` (SSE) | operator |
| `GET /api/metrics/health`, `/api/metrics/targets`, `/api/metrics/rules`, `/api/metrics/tsdb`, `/api/metrics/instant?name=` | operator |
| `GET /api/alerts/active`, `/api/alerts/groups`, `/api/alerts/silences`, `/api/alerts/receivers`, `/api/alerts/health` | operator |
| `GET /api/containers`, `/api/containers/health`, `/api/containers/inspect?id=`, `/api/containers/stats?id=` | operator |
| `GET /api/containers/summary` (also `GET /api/containers?detail=1`) | operator |
| `GET /api/containers/logs?id=&tail=` (SSE), `/api/containers/events` (SSE) | operator |
| `GET /api/search/index` | operator |
| `GET /api/audit/recent?limit=`, `/api/identity/principals`, `/api/pg/roles` | security |
| `GET /api/aws/identity`, `/api/aws/instances`, `/api/aws/buckets`, `/api/aws/databases`, `/api/aws/alarms`, `/api/aws/cost` | admin |
| `GET /api/overview` | admin |
| `GET /metrics` | bearer token, or public on a loopback bind with no token |
| anything else under `/` | the console page from `ARGUS_WEB_ROOT`; `/tests/` and any path segment that starts with `.` are refused |

`GET /api/containers/summary` lists every container with its restart count, start and finish times, exit code and restart policy in one answer: one `/containers/json` call, then at most four inspects at a time, each behind the cache, for up to 200 containers.

`GET /api/capabilities` never calls AWS. Its `aws` block says whether credentials are present (`configured`), where they come from (`credentialSource`) and whether the SDK is installed (`sdk`). Ask `GET /api/aws/identity` whether AWS accepts them.

## Live streams

Server-sent events streams hold at most `ARGUS_SSE_MAX_STREAMS` connections in all (503 `too-many-streams`, `scope: "server"`) and two per principal (429 `too-many-streams`, `scope: "principal"`). A stream opened by a session is re-checked, without renewing the session, on every heartbeat and every event, and it closes with an `event: session-ended` frame when the session is signed out, rotated away and gone, idle past its timeout, or at its absolute expiry, whichever comes first.

## Errors

Every non-2xx answer from the API has one shape:

```json
{ "ok": false, "error": "<reason>", "reason": "<reason>", "message": "<a sentence for a person>" }
```

`error` and `reason` are equal, except on a role denial, where `error` is `forbidden` and `reason` is `role` (with `required` and `held` tiers alongside). Some answers carry extra fields such as `path`, `scope`, `limit` or `signal`. A 4xx is logged at `info` and a 5xx at `error`.

| Status | `reason` values |
|---|---|
| 400 | `invalid-request` |
| 401 | `unauthenticated`, `invalid-credentials`, `duplicate-session-cookie` |
| 403 | `cross-site`, `role` (with `error: "forbidden"`), `forbidden`, `denied` |
| 404 | `not-found`, `no-such-endpoint`, `no-such-bucket`, `no-such-database` |
| 405 | `read-only`, `method-not-allowed` |
| 413 | `too-large` |
| 415 | `unsupported-type` |
| 421 | `misdirected` |
| 429 | `too-many-attempts`, `busy`, `too-many-streams` |
| 500 | `internal` |
| 503 | `unreachable`, `not-configured`, `no-sdk`, `too-many-streams`, `clock-skew` |
| 504 | `timeout` |

A reader whose upstream is down answers 200 with `ok: false` and a `reason` (for example `not-configured`, `unreachable`, `timeout`, `denied`), because the panel is still a valid answer. A stale cached answer carries `stale: true` and `staleBecause: { reason, message }`.

## Sign-in throttling

Each source address has one password verification in flight at a time; a second concurrent attempt is `429 busy` and counts as a soft failure against that source. A source is locked with an increasing delay after `ARGUS_AUTH_LOCKOUT_THRESHOLD` failures in `ARGUS_AUTH_LOCKOUT_WINDOW_MS` (429 with `Retry-After`). An operator name is locked the same way, but the lock only applies to sources that have themselves failed recently, so an attacker at one address cannot lock the real operator out from another. A locked attempt still spends the time of a password verification, and it answers with the same 401 as a wrong password. A failed sign-in logs the name only when it is a known operator; otherwise it logs `unknown:` and eight hex characters of an HMAC keyed per process, so a password typed into the name field never reaches the log.

## Audit

Audit events are JSON lines on stdout (stream `argus.console.audit`). Repeated denials (`auth.denied`, `auth.csrf.rejected`, `auth.host.rejected`, `auth.role.denied`, `auth.login.throttled` and similar) from one source are collapsed into one counted event per minute, with an `audit.collapsed` line carrying the count when the minute closes. Security events (sign-in, lockout, sign-out, role denials, configuration refusals) are kept in a ring of their own that request denials cannot evict. When `ARGUS_AUDIT_DIR` (or, if unset, `ARGUS_STATE_DIR`) is writable, security events are also appended to `console-audit.jsonl` there and restored at start; `GET /api/audit/recent` reports `persistence` as `file` or `memory`, and says why when it is `memory`.

## Metrics

`GET /metrics` is Prometheus text. With `ARGUS_METRICS_TOKEN` or `ARGUS_METRICS_TOKEN_FILE` set it needs `Authorization: Bearer <token>`, and an authenticated scrape includes the build version. With neither set it is public only while the server is bound to loopback; on any other bind it answers 401 until a token is configured. A token file that is set but unreadable keeps `/metrics` closed. The server says which of these applies on stderr at start.

## Environment

`node tools/env-vars.js` lists every variable the source reads, with the file and line; `node tools/env-vars.js --check` fails if this table misses an `ARGUS_` variable.

### Server and authentication

| Variable | Default | Meaning |
|---|---|---|
| `ARGUS_HOST` | `127.0.0.1` | Bind address. |
| `ARGUS_PORT` | `8787` | Bind port. |
| `ARGUS_ALLOWED_HOSTS` | empty | Comma list of extra `Host` names, each `name` or `name:port`, that the server answers for. |
| `ARGUS_WEB_ROOT` | `../../prototype` | Directory of the console page, relative to `src/`. |
| `ARGUS_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. |
| `ARGUS_ALLOW_WRITES` | `0` | Permit methods other than GET and HEAD. Nothing uses it yet. |
| `ARGUS_ENVIRONMENT` | empty | A short name for this deployment, shown read-only in the console header (lower-case letters, digits and hyphens, at most 32). Reported as `environment` in `/api/capabilities` once signed in. |
| `ARGUS_AUTH` | `session` | `session`, `proxy` or `off`. Any other value refuses to start. |
| `ARGUS_AUTH_OPERATORS_FILE` | `/config/operators.json` | Operator records for `session` mode. |
| `ARGUS_AUTH_PUBLIC_ORIGIN` | empty | The origin browsers use, for example `https://console.example.com`. Sets the origin check, the secure cookie default, HSTS and an allowed host. |
| `ARGUS_AUTH_SECURE_COOKIES` | derived | Force the `__Host-` secure cookie on or off. |
| `ARGUS_AUTH_IDLE_TIMEOUT_MS` | `1800000` | Session idle timeout. |
| `ARGUS_AUTH_ABSOLUTE_TIMEOUT_MS` | `28800000` | Session absolute lifetime, and the longest a stream can stay open. |
| `ARGUS_AUTH_RENEW_MS` | `3600000` | Session id rotation interval. |
| `ARGUS_AUTH_MAX_SESSIONS` | `64` | Sessions held at once; the least recently used is evicted. |
| `ARGUS_AUTH_SWEEP_INTERVAL_MS` | `60000` | How often expired sessions and throttle records are swept. |
| `ARGUS_AUTH_LOCKOUT_THRESHOLD` | `5` | Failures before a source or a name is locked. |
| `ARGUS_AUTH_LOCKOUT_WINDOW_MS` | `900000` | Window the failures are counted in. |
| `ARGUS_AUTH_LOCKOUT_BASE_MS` | `1000` | First lock length; it doubles with each further failure. |
| `ARGUS_AUTH_LOCKOUT_MAX_MS` | `900000` | Longest lock. |
| `ARGUS_AUTH_VERIFY_QUEUE_MAX` | `4` | Password verifications queued across all sources. |
| `ARGUS_AUTH_LOGIN_BODY_MAX_BYTES` | `4096` | Largest sign-in body. |
| `ARGUS_AUTH_SCRYPT_COST`, `ARGUS_AUTH_SCRYPT_BLOCK_SIZE`, `ARGUS_AUTH_SCRYPT_PARALLELISM`, `ARGUS_AUTH_SCRYPT_MAXMEM` | `65536`, `8`, `2`, `100663296` | scrypt parameters for new password records. |
| `ARGUS_AUTH_ORIGIN_ENFORCE` | `1` | Refuse cross-site requests (`0` only audits them). |
| `ARGUS_AUTH_CLIENT_HEADER` | `x-argus-console` | Custom header state-changing requests must carry. |
| `ARGUS_AUTH_TRUSTED_PROXY_CIDRS` | empty | Peers trusted as a reverse proxy, for example `172.28.0.0/16`. Required in `proxy` mode. |
| `ARGUS_AUTH_TRUST_FORWARDED_FOR` | `0` | Take the source address from `X-Forwarded-For`, read from the right, skipping trusted proxies. |
| `ARGUS_AUTH_PROXY_SHARED_SECRET` | empty | Secret the proxy must send; required in `proxy` mode. |
| `ARGUS_AUTH_PROXY_SECRET_HEADER` | `x-argus-proxy-auth` | Header carrying that secret. |
| `ARGUS_AUTH_PROXY_IDENTITY_HEADER` | `remote-user` | Header carrying the subject. |
| `ARGUS_AUTH_PROXY_GROUPS_HEADER` | `remote-groups` | Header carrying the roles. |
| `ARGUS_AUTH_PROXY_NAME_HEADER` | `remote-name` | Header carrying the display name. |
| `ARGUS_AUTH_HSTS_MAX_AGE` | `63072000` | HSTS max-age when the public origin is https. |
| `ARGUS_METRICS_TOKEN` | empty | Bearer token for `/metrics`. |
| `ARGUS_METRICS_TOKEN_FILE` | empty | File holding that token, read once at start. |
| `ARGUS_AUDIT_RING_EVENTS` | `2000` | General audit ring size. |
| `ARGUS_AUDIT_SECURITY_RING_EVENTS` | `1000` | Security audit ring size. |
| `ARGUS_STATE_DIR` | `/state` | Where `storage-init` writes its report, and where the security audit is persisted when writable. |
| `ARGUS_AUDIT_DIR` | unset | A writable directory for the security audit file. Takes precedence over `ARGUS_STATE_DIR` for the audit only; compose mounts a small volume at `/audit`. |

### Caching, streams and heartbeats

| Variable | Default | Meaning |
|---|---|---|
| `ARGUS_CACHE_TTL_MS` | `30000` | Default reader cache lifetime (AWS readers). |
| `ARGUS_CACHE_MAX_ENTRIES` | `500` | Cache entries kept. |
| `ARGUS_UPSTREAM_TIMEOUT_MS` | `8000` | Default upstream timeout. |
| `ARGUS_SSE_HEARTBEAT_MS` | `15000` | Stream heartbeat, which is also when a stream re-checks its session. |
| `ARGUS_SSE_RETRY_MS` | `3000` | Reconnect delay sent to the browser. |
| `ARGUS_SSE_MAX_STREAMS` | `8` | Streams held at once in all. |
| `ARGUS_HEARTBEAT_INTERVAL_MS` | `30000` | Component probe interval. |
| `ARGUS_HEARTBEAT_MAX_RETRIES` | `2` | Failures before a component is marked down. |
| `ARGUS_HEARTBEAT_BEAT_CAP` | `1000` | Beats kept per component. |
| `ARGUS_LOG_RING_LINES` | `2000` | Log lines kept per query for resume. |
| `ARGUS_LOG_RING_QUERIES` | `8` | Log queries kept for resume. |
| `ARGUS_LOG_TAIL_LIMIT` | `200` | Default log tail length. |

### Upstreams

| Variable | Default | Meaning |
|---|---|---|
| `ARGUS_SEAWEED_MASTER_URL` | `http://seaweed-master:9333` | SeaweedFS master. |
| `ARGUS_SEAWEED_FILER_URL` | `http://seaweed-filer:8888` | SeaweedFS filer. |
| `ARGUS_SEAWEED_NODE_URL_MAP` | empty | `from=to` pairs rewriting volume server addresses. |
| `ARGUS_S3_ENDPOINT` | `http://seaweed-s3:8333` | S3 gateway. |
| `ARGUS_S3_REGION` | `us-east-1` | S3 signing region. |
| `ARGUS_S3_ACCESS_KEY_ID`, `ARGUS_S3_SECRET_ACCESS_KEY` | empty | The console's S3 credential. |
| `ARGUS_S3_VOLUME_SIZE_MB` | `1024` | Volume size, for the object count caveat. |
| `ARGUS_S3_IDENTITIES_FILE` | empty | SeaweedFS identities file, listed without secret keys. |
| `ARGUS_BUCKETS_FILE` | `/config/buckets.yaml` | Declared buckets. |
| `ARGUS_PG_HOST`, `ARGUS_PG_PORT`, `ARGUS_PG_USER`, `ARGUS_PG_PASSWORD`, `ARGUS_PG_DATABASE` | empty, `5432`, empty, empty, `postgres` | PostgreSQL connection. |
| `ARGUS_PG_SSLMODE`, `ARGUS_PG_CA_FILE` | `disable`, empty | PostgreSQL TLS. |
| `ARGUS_GARNET_HOST`, `ARGUS_GARNET_PORT`, `ARGUS_GARNET_USER`, `ARGUS_GARNET_PASSWORD` | `garnet`, `6379`, `console`, empty | Garnet connection. |
| `ARGUS_GARNET_TIMEOUT_MS`, `ARGUS_GARNET_PROBE_TTL_MS`, `ARGUS_GARNET_DBSIZE_TTL_MS` | upstream timeout, `10000`, `300000` | Garnet timing. |
| `ARGUS_GARNET_MEM_LIMIT_BYTES` | empty | The container memory limit, for the memory panel. |
| `ARGUS_NATS_MONITOR_URL`, `ARGUS_NATS_ACCOUNT` | `http://nats:8222`, `ARGUS` | NATS monitoring port and account. |
| `ARGUS_QUEUE_CACHE_TTL_MS` | `5000` | NATS cache lifetime. |
| `ARGUS_OPENBAO_ADDR` | empty | OpenBao address. |
| `ARGUS_UNSEAL_MODE` | `sandbox` (assumed) | `sandbox` or `ceremony`, as asked for. |
| `ARGUS_LOKI_URL`, `ARGUS_LOKI_TENANT` | empty | Loki and its tenant. |
| `ARGUS_LOKI_TIMEOUT_MS`, `ARGUS_LOKI_HEALTH_TTL_MS`, `ARGUS_LOKI_LABELS_TTL_MS`, `ARGUS_LOKI_QUERY_TTL_MS` | upstream timeout, `10000`, `30000`, `5000` | Loki timing. |
| `ARGUS_PROM_URL` | empty | Prometheus. |
| `ARGUS_PROM_TIMEOUT_MS`, `ARGUS_PROM_HEALTH_TTL_MS`, `ARGUS_PROM_SERIES_TTL_MS`, `ARGUS_PROM_STATUS_TTL_MS` | upstream timeout, `10000`, `15000`, `30000` | Prometheus timing. |
| `ARGUS_ALERTMANAGER_URL` | empty | Alertmanager. |
| `ARGUS_ALERTMANAGER_TIMEOUT_MS`, `ARGUS_ALERTMANAGER_TTL_MS` | upstream timeout, `10000` | Alertmanager timing. |
| `ARGUS_DOCKER_PROXY_URL`, `ARGUS_DOCKER_API_VERSION` | empty, `v1.43` | Docker socket proxy. |
| `ARGUS_DOCKER_TIMEOUT_MS`, `ARGUS_DOCKER_LIST_TTL_MS`, `ARGUS_DOCKER_STATS_TTL_MS` | upstream timeout, `10000`, `5000` | Docker timing. |
| `ARGUS_GITOPS_DIR` | `/config/gitops` | GitOps declarations. |
| `ARGUS_RUNBOOKS_DIR` | `/config/runbooks` | Runbooks. Links that leave the directory are not followed. |
| `ARGUS_AWS_TIMEOUT_MS` | `8000` | AWS call timeout. |
| `ARGUS_COST_ENABLED`, `ARGUS_COST_CACHE_TTL_MS` | `0`, `21600000` | Cost Explorer, which is billed per call. |

The AWS readers also use the standard SDK variables (`AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE` and the rest). Every AWS client except S3 is an optional dependency; without them the AWS routes answer `no-sdk`.
