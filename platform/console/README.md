# Argus Console

`Argus.Console.Api` (.NET 10 minimal API) · `Argus.Console.Web` (Next.js 16, standalone) · `Argus.Reconciler` (Service Fabric stateful service). See `docs/05-CONTROL-PLANE.md`.

Conventions are the Mills dashboard's: bare camelCase records, RFC 9457 ProblemDetails, `/api/v1` prefix, hand-rolled `Validate()`, xUnit + `WebApplicationFactory` on SQLite with fakes, config from environment variables only.

```
src/
  Argus.Console.Api/       Program.cs · Features/{Overview,Apps,Deployments,Storage,Databases,Secrets,Identity,Hosts,Security,Ml,Runbooks,Audit}
  Argus.Console.Web/       Next.js app — (app)/overview, apps, deployments, storage, databases, secrets, identity, hosts, security, ml, runbooks, audit
  Argus.Reconciler/        Reconciler stateful service — Model/, Readers/{ServiceFabric,HyperV,SeaweedFS,OpenBao,Ad,Dsc,OpnSense}, Appliers/, Planner.cs
  Argus.Shared/            Records shared by API and reconciler
tests/
```

First screens to ship (Phase 2): Deployments, Applications. Everything else is Windows Admin Center + Grafana until Phase 6.
