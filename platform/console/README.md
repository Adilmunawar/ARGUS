# Argus Console

The Argus Console is the operator interface and control plane for the platform, built from three parts:

* `Argus.Console.Api`: a .NET 10 minimal API.
* `Argus.Console.Web`: a Next.js 16 standalone web app.
* `Argus.Reconciler`: a Service Fabric stateful service.

See [the control plane design](../../docs/05-CONTROL-PLANE.md) for the full picture.

Conventions follow the Mills dashboard: bare camelCase records, RFC 9457 ProblemDetails, the `/api/v1` prefix, hand rolled `Validate()`, xUnit with `WebApplicationFactory` on SQLite with fakes, and configuration from environment variables only.

```
src/
  Argus.Console.Api/       Program.cs · Features/{Overview,Apps,Deployments,Storage,Databases,Secrets,Identity,Hosts,Security,Ml,Runbooks,Audit}
  Argus.Console.Web/       Next.js app: (app)/overview, apps, deployments, storage, databases, secrets, identity, hosts, security, ml, runbooks, audit
  Argus.Reconciler/        Reconciler stateful service: Model/, Readers/{ServiceFabric,HyperV,SeaweedFS,OpenBao,Ad,Dsc,OpnSense}, Appliers/, Planner.cs
  Argus.Shared/            Records shared by API and reconciler
tests/
```

The first screens to ship (Phase 2) are Deployments and Applications. Everything else is served by Windows Admin Center and Grafana until Phase 6.
