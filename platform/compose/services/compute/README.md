# Compute

Nomad configuration for the `compute` profile, mounted read-only at `/etc/nomad.d`.

Service Fabric is the primary orchestrator for Argus. Nomad here is secondary, and the profile is off by default.

## Files

| File | Holds |
| --- | --- |
| `nomad.d/agent.hcl` | region, datacenter, data directory, bind and advertise addresses, ports, ACL and telemetry |
| `nomad.d/server.hcl` | the server stanza for a single-node cluster |
| `nomad.d/client.hcl` | the client stanza, host volumes and reserved resources |
| `nomad.d/drivers.hcl` | the docker driver, with `raw_exec` disabled and privileged containers refused |

Telemetry is exposed in Prometheus format so `services/observability/prometheus` can scrape it.

## The one service without `no-new-privileges`

Every other service in `docker-compose.yml` carries `security_opt: ["no-new-privileges:true"]`. Nomad does not, and the omission is deliberate: it is a container orchestrator, and the flag prevents a process from gaining privileges through `setuid` binaries, which is part of how a task driver starts work.

That exception matters more than it looks, because of what else this service holds:

- `cap_add: SYS_ADMIN`
- `pid: host`
- `apparmor:unconfined`
- the Docker socket, read-write
- `/sys/fs/cgroup`, read-write

Any one of those is close to root on the host. Together they are root on the host, and `no-new-privileges` would not meaningfully change that — which is the honest reason the exception costs little, rather than a claim that the service is confined.

The consequence is the part to keep in mind: **whoever can submit a Nomad job can take the host.** The profile is off by default, its ACL configuration is the real control surface, and nothing should enable this profile on a machine where that trust does not already hold. The parity profile's own rule — it observes, it cannot act, and it is deliberately given no Docker socket — is the contrast worth measuring this against.

If the compute profile is ever promoted from secondary to load-bearing, the first question to settle is whether Nomad runs in a container at all, rather than which flags it carries.
