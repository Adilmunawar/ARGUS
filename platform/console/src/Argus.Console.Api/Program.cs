// Argus Console API: the Phase 0 skeleton. Same posture as the Mills API:
// refuses to boot without required config, prints an integration roll call,
// env vars always win, no secrets on disk.
using Microsoft.AspNetCore.Authentication.JwtBearer;

var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddEnvironmentVariables();

string Require(string key) =>
    builder.Configuration[key] ?? throw new InvalidOperationException($"{key} is required, refusing to boot.");

var adfsAuthority = Require("Auth:Authority");      // https://adfs.argus.local/adfs
var gitopsRepo    = Require("GitOps:RepoUrl");      // https://forgejo.argus.local/ZaraatDost/argus-gitops
var openBaoAddr   = Require("OpenBao:Address");     // https://openbao.argus.local:8200

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o => { o.Authority = adfsAuthority; o.Audience = "argus-console"; });
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("viewer",   p => p.RequireRole("Argus-Console-Viewers", "Argus-Console-Operators", "Argus-Console-Approvers", "Argus-Console-Security", "Argus-Console-Admins"))
    .AddPolicy("operator", p => p.RequireRole("Argus-Console-Operators", "Argus-Console-Admins"))
    .AddPolicy("approver", p => p.RequireRole("Argus-Console-Approvers", "Argus-Console-Admins"))
    .AddPolicy("security", p => p.RequireRole("Argus-Console-Security", "Argus-Console-Admins"))
    .AddPolicy("admin",    p => p.RequireRole("Argus-Console-Admins"));

builder.Services.AddProblemDetails();
builder.Services.AddOpenApi();

var app = builder.Build();
app.UseExceptionHandler();
app.UseAuthentication();
app.UseAuthorization();

var v1 = app.MapGroup("/api/v1");
v1.MapGet("/health", () => Results.Ok(new { status = "healthy", version = typeof(Program).Assembly.GetName().Version?.ToString() }));

// Feature slices register here: Overview, Apps, Deployments, Storage, Databases,
// Secrets, Identity, Hosts, Security, Ml, Runbooks, Audit. Every write creates a
// pull request on the GitOps repo and an audit row; none touches a system directly.
// v1.MapAppsEndpoints(); v1.MapDeploymentsEndpoints(); ...

app.Logger.LogInformation("Argus Console API booted ({Env})", app.Environment.EnvironmentName);
app.Logger.LogInformation("Integration AD FS: {A}", adfsAuthority);
app.Logger.LogInformation("Integration GitOps: {R}", gitopsRepo);
app.Logger.LogInformation("Integration OpenBao: {O}", openBaoAddr);
app.Run();
