# ADR-0005: Service Fabric as the application scheduler; guest executables

**Context.** The applications are .NET services (API, gateway, console, functions host) and Node processes (Next.js standalone). They need placement, health-gated rolling upgrades, automatic restart and horizontal scaling, what Kubernetes gives Linux.

**Options.** (a) Service Fabric standalone cluster on Windows Server. (b) HashiCorp Nomad (Windows binary; BSL licence). (c) Windows Containers on Kubernetes worker nodes with a Linux control plane. (d) WinSW/NSSM services per host with a custom supervisor (status quo, scaled).

**Decision.** (a). Service Fabric standalone, 5 nodes (3 seed), applications packaged as **guest executables** (`.sfpkg`), not containers.

**Why.** Service Fabric is MIT-licensed, Windows-native, and runs Azure's own control plane. Its upgrade model (health-checked, rolling, automatic rollback) is exactly what `update.ps1` does by hand today. Guest executables mean the existing self-contained `dotnet publish` output and the Next.js standalone tree deploy as-is: no Dockerfiles, no registry, no container runtime on Windows. Nomad was the runner-up; its BSL licence permits this use but the Windows story is thinner and it brings no stateful-service model.

**Consequences.** The team learns Service Fabric's manifests and health model. Stateful reliable services are available but not used in v1 (state stays in SQL/Postgres/NATS). If Linux containers are ever required, they run on a Linux VM under ADR-0003's amendment process.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)
