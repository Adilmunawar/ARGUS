# Argus compose stack

A single-machine Argus: object storage, PostgreSQL with PostGIS, cache, queues, secrets, observability and the Argus console, run by Docker Compose. It is a sandbox for development, demos and CI. It is not a production layout: production runs on the platform described in `docs/`, and several shortcuts here (one OpenBao key share on disk, one node of everything) exist only so that one command produces a working system on a laptop.

Everything is driven by `stack.js`, a Node script with no dependencies that runs the same way on Windows, Linux and macOS.

```
node stack.js bootstrap
node stack.js up --wait
```

Then open `http://127.0.0.1:8787` and sign in (see [Signing in](#signing-in)).

## Prerequisites

| | Windows 10/11 | macOS | Linux |
|---|---|---|---|
| Docker | Docker Desktop with the WSL2 backend, Linux containers | Docker Desktop (or OrbStack, Colima) | Docker Engine 25 or later with the compose plugin |
| Compose | 2.20 or later (bundled) | 2.20 or later (bundled) | `docker compose version` must say 2.20 or later |
| Node | 20 or later on `PATH` | 20 or later | 20 or later |
| Memory given to Docker | 10 GB or more for the default profiles | same, in Docker Desktop settings | the host's RAM |

On Windows, WSL2 takes half the machine's RAM unless `%USERPROFILE%\.wslconfig` says otherwise. A workable file:

```
[wsl2]
memory=10GB
processors=6
```

then `wsl --shutdown` and start Docker Desktop again. `bootstrap` warns when the file is missing.

PostGIS and Guacamole 1.5.5 publish linux/amd64 images only. On Apple silicon and other arm64 hosts Docker runs them under emulation, which works but is slow; every other image is multi-arch.

## Commands

| Command | What it does |
|---|---|
| `node stack.js bootstrap` | Writes `.env` and `secrets/`. If they exist it only adds what is missing: new keys from `.env.example`, credentials that are empty, file secrets that are absent. It never rewrites an existing credential. |
| `node stack.js bootstrap --rotate` | Regenerates every credential and file secret. Run `reset --yes` first, or the running stack is locked out of its own databases. |
| `node stack.js bootstrap --ci` | Non-interactive, skips the Docker Desktop checks. CI uses this instead of copying `.env.example`. |
| `node stack.js up [--profiles a,b] [--ports] [--wait] [--timeout s] [--build]` | Starts the stack. Profiles default to `COMPOSE_PROFILES` in `.env`. `--wait` blocks until every long-running service is healthy and every one-shot has exited 0, and exits non-zero otherwise. `--ports` also publishes the internal control planes (see [Ports](#ports)). |
| `node stack.js status [--json] [--profiles a,b]` | One line per service, the console URL and the operator name. Exits 1 if any long-running service is not healthy or any one-shot did not exit 0. |
| `node stack.js logs [service] [--follow] [--tail n]` | `docker compose logs` across every profile. |
| `node stack.js doctor [--json] [--ports]` | Checks the engine, Linux containers, memory limits of the enabled profiles against what the engine has, every published port, the subnet against Docker networks and host interfaces, file secrets and their permissions, and that `.env` has every key. |
| `node stack.js down` | Stops every profile. Volumes are kept. |
| `node stack.js down --volumes --yes` | Stops everything and deletes every volume. Without `--yes` it lists the volumes and stops. |
| `node stack.js reset --yes` | `down --volumes`, then deletes `.env` and `secrets/`. Follow it with `bootstrap` and `up`. |

`bootstrap.ps1` and `down.ps1` still work and call `stack.js` (`bootstrap.ps1 -Rotate`, `down.ps1 -DeleteData`).

`docker compose up -d` on its own also works: `.env` carries `COMPOSE_PROFILES`, so it starts the same default profiles.

## Profiles

The services without a profile always run. `COMPOSE_PROFILES` in `.env.example` turns on `cache,queues,secrets,observability`.

| Profile | Services | Memory limits (long-running) | Default |
|---|---|---|---|
| core | seaweed-master, seaweed-volume, seaweed-filer, seaweed-s3, postgres, console, docker-socket-proxy; one-shots seaweed-config, storage-init, pg-init | 2.7 GiB | always |
| cache | garnet; one-shot garnet-init | 0.75 GiB (`GARNET_MEM_LIMIT`) | on |
| queues | nats; one-shot nats-init | 0.5 GiB | on |
| secrets | openbao, openbao-unseal; one-shot bao-init | 0.3 GiB | on |
| observability | prometheus, alertmanager, mailpit, loki, alloy, grafana, node-exporter, postgres-exporter, garnet-exporter, nats-exporter | 3.5 GiB | on |
| connect | guacd, guacamole; one-shots guac-storage-init, guac-init | 1.25 GiB | off |
| targets | target-ssh, target-rdp (machines for Guacamole to reach) | 1.1 GiB | off |
| compute | nomad, azurite; one-shot nomad-acl-init | 1.5 GiB | off |
| parity | parity, parity-reference (LocalStack), parity-pg, plus nats and openbao | 2.0 GiB plus nats and openbao | off |

The default set has 7.8 GiB of memory limits. Real use is well under that at rest; the limits are ceilings, and `doctor` compares their sum with what the engine has.

Add a profile for one run with `node stack.js up --profiles cache,queues,secrets,observability,connect --wait`, or change `COMPOSE_PROFILES` in `.env` to make it stick.

## Ports

By default only two ports are published, both on 127.0.0.1:

| Port | Variable | Service |
|---|---|---|
| 8787 | `CONSOLE_PORT` | the Argus console |
| 3000 | `GRAFANA_PORT` | Grafana |

Everything else is reachable only on the `argus` network. The control planes there have no authentication of their own (the SeaweedFS filer will delete object-locked data without asking the S3 gateway, Prometheus and Alertmanager accept any API call), so they are not published unless you ask:

```
node stack.js up --ports --wait
```

adds `docker-compose.ports.yml`, which publishes on 127.0.0.1:

| Port | Variable | Service |
|---|---|---|
| 5432 | `PG_PORT` | PostgreSQL |
| 6379 | `GARNET_PORT` | Garnet |
| 4222, 8222 | `NATS_PORT`, `NATS_MONITOR_PORT` | NATS client and monitor |
| 8200 | `OPENBAO_PORT` | OpenBao |
| 9333, 8080, 8888, 8333 | `SEAWEED_MASTER_PORT`, `SEAWEED_VOLUME_PORT`, `SEAWEED_FILER_PORT`, `SEAWEED_S3_PORT` | SeaweedFS master, volume, filer and S3 gateway |
| 9090, 9093, 8025 | `PROMETHEUS_PORT`, `ALERTMANAGER_PORT`, `MAILPIT_PORT` | Prometheus, Alertmanager, Mailpit |
| 4646 | `NOMAD_PORT` | Nomad (compute profile) |
| 9781, 4566 | `PARITY_PORT`, `LOCALSTACK_PORT` | parity harness and its LocalStack reference |

Change any of them in `.env` if something else on the machine holds the port; `doctor --ports` checks them all.

## Signing in

`bootstrap` writes one console operator, `CONSOLE_OPERATOR` in `.env` (default `argus-admin`), with role `admin`. Its scrypt record is in `secrets/operators.json` and its password in `secrets/console_operator_password`. Read the password from that file; it is never printed.

Use `http://127.0.0.1:8787`, not `localhost`: the publishes are IPv4 only and some clients try `::1` first.

Grafana is at `http://127.0.0.1:3000`, user `GRAFANA_ADMIN_USER` (default `argus-admin`), password in `secrets/grafana_admin_password`.

The Guacamole break-glass account (connect profile) is `GUAC_BREAKGLASS_USER`, password in `secrets/guac_breakglass_password`.

## Secrets

`secrets/` and `.env` are gitignored and exist only on the machine that ran `bootstrap`.

* Windows: `secrets/` is created first with inheritance removed and full control for the current user, SYSTEM and Administrators only, so every file in it inherits that; each file and `.env` are then set the same way explicitly. `bootstrap` fails if `icacls` cannot do this.
* Linux and macOS: `secrets/` is 0700. Files bind-mounted into containers are 0644, because the containers read them as other users (postgres 999, grafana 472, Alertmanager nobody); the directory is what keeps other host users out. Files only the host needs (`console_operator_password`, `guac_breakglass_password`, `nomad_token`) and `.env` are 0600.

`doctor` checks both.

| File | Used by |
|---|---|
| `pg_superuser_password` | postgres, pg-init |
| `pg_exporter_password`, `grafana_db_password` | postgres-exporter, grafana (same values as the matching `.env` keys) |
| `grafana_admin_password` | grafana |
| `console_alert_token` | alertmanager |
| `console_metrics_token` | the console's `/metrics` (`ARGUS_METRICS_TOKEN_FILE`) and Prometheus's bearer token for it |
| `operators.json`, `console_operator_password` | the console sign-in |
| `alertmanager.yml` | rendered from `services/observability/alertmanager/alertmanager.yml.tmpl` |
| `garnet/users.acl` | garnet (default user off, `console` observe-only) |
| `guac_breakglass_password` | the Guacamole break-glass login |
| `nomad_token` | written by nomad-acl-init: the Nomad management token |

## Console settings in this stack

The console service sets these; `platform/console/server/README.md` has the full list.

| Variable | Value here | Why |
|---|---|---|
| `ARGUS_ALLOWED_HOSTS` | `console:8787,127.0.0.1:${CONSOLE_PORT},localhost:${CONSOLE_PORT}` | the Host allowlist answers 421 to anything else; `console:8787` is how Prometheus reaches it |
| `ARGUS_METRICS_TOKEN_FILE` | `/run/secrets/console_metrics_token` | `/metrics` is closed on a non-loopback bind without a token; Prometheus sends the same file as a bearer token. `ARGUS_METRICS_TOKEN` (inline) is the alternative and is not used here |
| `ARGUS_ENVIRONMENT` | `${ARGUS_ENVIRONMENT:-sandbox}` | shown read-only in the console header |
| `ARGUS_STATE_DIR` | `/state`, read-only | storage-init's verdicts; the console must not be able to rewrite them |
| `ARGUS_AUDIT_DIR` | `/audit` (volume `argus_console_audit`) | a writable home for the security audit trail, kept apart from `/state`. Until the server reads this variable it keeps audit events in memory, because `/state` is read-only |
| `ARGUS_AUDIT_SECURITY_RING_EVENTS` | server default | size of the in-memory security event ring |

## What each service does

| Service | Role |
|---|---|
| seaweed-config | writes `filer.toml`, the gateway identities `s3.json` (root only, in `argus_seaweed_conf`) and `s3-public.json` (names, access keys and actions, no secret keys, in `argus_seaweed_public`) |
| seaweed-master, seaweed-volume, seaweed-filer, seaweed-s3 | SeaweedFS object storage; the S3 gateway is the only path that enforces Object Lock |
| storage-init | creates the buckets in `platform/gitops/storage/buckets.yaml`, applies lock and lifecycle, probes WORM enforcement |
| postgres, pg-init | PostgreSQL 17 with PostGIS; pg-init creates the roles and databases in `sql/` |
| console | the Argus console and its API, read-only by default (`ARGUS_ALLOW_WRITES=0`). Its S3 identity keeps Read, List and Write on the eight application buckets: SeaweedFS 3.97 checks Write on every bucket request, list and head included, so an identity with only Read and List is refused everything |
| docker-socket-proxy | an allowlisting proxy in front of the Docker socket for the console and Alloy: GET and HEAD of `_ping`, `version`, `info`, `containers/json`, `containers/{id}/json`, `containers/{id}/stats`, `containers/{id}/logs`, `events` and `networks`, nothing else. `containers/{id}/json` includes each container's environment; the console withholds `Env` in code and reports only how many entries it hid |
| garnet, garnet-init | Redis-compatible cache; garnet-init proves authentication is on and the console user cannot read or flush |
| nats, nats-init | NATS with JetStream; nats-init applies the streams |
| openbao, openbao-unseal, bao-init | OpenBao. In `ARGUS_UNSEAL_MODE=sandbox` bao-init initialises a 1-of-1 seal, keeps the key in `argus_openbao_seal` and provisions engines, policies and the console AppRole. It keeps no root token: it mints one from the key for each run and revokes it before exiting |
| prometheus, alertmanager, mailpit | metrics, alert routing, and a mail sink for the alert mail |
| loki, alloy | logs; Alloy reads container logs through the socket proxy, redacts credentials (key=value and JSON), drops the socket proxy's access lines, and ships to Loki |
| grafana | dashboards over Prometheus and Loki, state in PostgreSQL |
| node-exporter, postgres-exporter, garnet-exporter, nats-exporter | exporters |
| guacd, guacamole, guac-storage-init, guac-init | browser RDP and SSH; guac-init seeds the schema and the break-glass admin |
| target-ssh, target-rdp | deliberately reachable test machines, on their own internal network shared only with guacd |
| nomad, nomad-acl-init | Nomad, on its own network with the console; nomad-acl-init bootstraps the ACL system once and stores the management token in `secrets/nomad_token` |
| azurite | Azure Storage emulator |
| parity, parity-reference, parity-pg | the S3 parity harness against LocalStack, run from the console image |

## Volumes

All are named `argus_*` and survive `down`; `down --volumes --yes` and `reset --yes` delete them.

| Volume | Holds |
|---|---|
| `argus_seaweed_master`, `argus_seaweed_volume`, `argus_seaweed_filer` | SeaweedFS topology, objects, filer metadata |
| `argus_seaweed_conf` | `filer.toml` and `s3.json` with every S3 secret key |
| `argus_seaweed_public` | `s3-public.json`, no secret keys; mounted into the console and storage-init |
| `argus_pg_data` | every database |
| `argus_garnet_data` | cache spill (safe to lose) |
| `argus_nats_data` | streams and unacknowledged messages |
| `argus_openbao_data`, `argus_openbao_logs`, `argus_openbao_seal` | the vault raft, its audit log, the sandbox unseal key |
| `argus_console_state` | bucket and WORM verdicts from storage-init |
| `argus_console_audit` | the console security audit trail |
| `argus_prometheus_data`, `argus_alertmanager_data`, `argus_mailpit_data`, `argus_loki_data`, `argus_alloy_data`, `argus_grafana_data` | observability state |
| `argus_guac_recordings`, `argus_guac_drives` | session recordings (audit evidence) and transfers |
| `argus_nomad_data` | Nomad state (default for `ARGUS_NOMAD_DATA`) |
| `argus_azurite_data` | Azurite data |
| `argus_parity_results` | parity reports |

Losing `argus_openbao_seal` while keeping `argus_openbao_data` leaves a vault nothing can open. Remove both or neither.

## Hardening

Every service drops all capabilities and adds back only what it needs (postgres: CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID; the linuxserver targets and LocalStack: their init systems' set; Nomad: what a task driver needs). Most run with a read-only root filesystem and a small tmpfs. Every container has `no-new-privileges` except Nomad, for the reason in `services/compute/README.md`, and every one rotates its logs at 3 x 10 MB.

Image references in `.env.example` carry digests (the multi-arch list digest where one exists), so a tag cannot move under a running stack. To move to a new version, change the reference in `.env.example`, resolve its digest with `docker buildx imagetools inspect <image:tag>`, and copy it into `.env`.

## Troubleshooting

**`bootstrap` says the engine is not running.** Start Docker Desktop and wait until it reports running. On a fresh Windows install the WSL2 integration usually needs one reboot.

**A service is unhealthy.** `node stack.js status` names it; `node stack.js logs <service>` shows why. `node stack.js doctor` catches the usual causes: a port held by something else, a subnet clash, a missing secret.

**After restarting Docker Desktop, the filer crash-loops and takes the console with it.** That was the storage config being readable only by a user SeaweedFS does not run as: it kept working only while the files were already open. seaweed-config now writes `filer.toml` and `s3-public.json` world-readable and `s3.json` owned by root and readable by root only, which is the user SeaweedFS runs as. If you still see it, an old `argus_seaweed_conf` survived from before the fix: `node stack.js up` reruns seaweed-config, which rewrites both files.

**A changed identity in seaweed-config does not take effect.** The S3 gateway reads `s3.json` when it starts. After changing the identities, `docker compose restart seaweed-s3`.

**`docker compose` says a variable is missing (`run node stack.js bootstrap`).** `.env` predates a key that `.env.example` now has. `node stack.js bootstrap` adds it without touching anything else.

**Port already in use.** Change the matching `*_PORT` in `.env`.

**The subnet clashes with a VPN or another network.** Set `ARGUS_SUBNET` in `.env` to an unused /16 and rerun `bootstrap`, which re-derives `ARGUS_SUBNET_REGEX`.

**OpenBao stays sealed.** `node stack.js logs openbao-unseal`. In sandbox mode it unseals with the key in `argus_openbao_seal`; if that volume was recreated while `argus_openbao_data` survived, nothing can open the vault, and the fix is to remove both.

**Start over.** `node stack.js reset --yes`, `node stack.js bootstrap`, `node stack.js up --wait`.
